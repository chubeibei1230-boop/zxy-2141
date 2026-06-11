const { db } = require('../database');
const dayjs = require('dayjs');

function generateApplicationNo() {
  const dateStr = dayjs().format('YYYYMMDD');
  const prefix = 'PO' + dateStr;
  const row = db.prepare(
    "SELECT application_no FROM purchase_applications WHERE application_no LIKE ? ORDER BY application_no DESC LIMIT 1"
  ).get(prefix + '%');

  let seq = 1;
  if (row) {
    const lastSeq = parseInt(row.application_no.substring(prefix.length));
    seq = lastSeq + 1;
  }
  return prefix + String(seq).padStart(4, '0');
}

function findApprovalRule(budgetSubjectId, amount, urgencyLevel) {
  const exactRules = db.prepare(`
    SELECT * FROM approval_rules
    WHERE status = 1
      AND (budget_subject_id = ? OR budget_subject_id IS NULL)
      AND (urgency_level = ? OR urgency_level = 'all')
      AND ? >= min_amount AND ? <= max_amount
    ORDER BY
      CASE WHEN budget_subject_id IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN urgency_level != 'all' THEN 0 ELSE 1 END,
      approval_levels DESC
    LIMIT 1
  `).get(budgetSubjectId, urgencyLevel, amount, amount);

  return exactRules || null;
}

function createApprovalNodes(applicationId, rule) {
  const auditorIds = JSON.parse(rule.auditor_ids);
  const insertNode = db.prepare(`
    INSERT INTO approval_nodes (application_id, node_index, auditor_id, assigned_auditor_id, status)
    VALUES (?, ?, ?, ?, 'pending')
  `);

  auditorIds.forEach((auditorId, index) => {
    insertNode.run(applicationId, index, auditorId, auditorId);
  });
}

function logOperation(applicationId, userId, node, action, fromStatus, toStatus, comment) {
  db.prepare(`
    INSERT INTO operation_logs (application_id, user_id, node, action, from_status, to_status, comment)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(applicationId || null, userId, node, action, fromStatus || null, toStatus || null, comment || null);
}

function getCurrentNode(applicationId) {
  return db.prepare(`
    SELECT an.*, u.real_name as auditor_name, u.username as auditor_username,
           au.real_name as assigned_auditor_name
    FROM approval_nodes an
    JOIN purchase_applications pa ON an.application_id = pa.id
    LEFT JOIN users u ON an.auditor_id = u.id
    LEFT JOIN users au ON an.assigned_auditor_id = au.id
    WHERE an.application_id = ? AND an.node_index = pa.current_node_index
      AND an.status = 'pending'
    ORDER BY an.id DESC
    LIMIT 1
  `).get(applicationId);
}

function getAllNodesWithAuditors(applicationId) {
  return db.prepare(`
    SELECT an.*, u.real_name as auditor_name, u.username as auditor_username,
           au.real_name as assigned_auditor_name, au.username as assigned_auditor_username,
           tu.real_name as transferred_to_name,
           pu.real_name as previous_auditor_name
    FROM approval_nodes an
    LEFT JOIN users u ON an.auditor_id = u.id
    LEFT JOIN users au ON an.assigned_auditor_id = au.id
    LEFT JOIN users tu ON an.transferred_to_id = tu.id
    LEFT JOIN users pu ON an.previous_auditor_id = pu.id
    WHERE an.application_id = ?
    ORDER BY an.node_index, an.id
  `).all(applicationId);
}

function submitApplication(applicationId, userId) {
  const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(applicationId);
  if (!app) throw new Error('采购申请不存在');
  if (app.status !== 'draft' && app.status !== 'returned') {
    throw new Error('当前状态不允许提交，只有草稿或退回状态可以提交');
  }

  if (app.urgency_level === 'urgent' && (!app.urgent_reason || app.urgent_reason.trim() === '')) {
    throw new Error('紧急申请必须填写紧急原因');
  }

  const rule = findApprovalRule(app.budget_subject_id, app.total_amount, app.urgency_level);
  if (!rule) {
    throw new Error('未找到匹配的审批规则，请联系管理员配置');
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM approval_nodes WHERE application_id = ?').run(applicationId);

    createApprovalNodes(applicationId, rule);
    const auditorIds = JSON.parse(rule.auditor_ids);
    const firstAuditorId = auditorIds[0];

    const oldStatus = app.status;
    db.prepare(`
      UPDATE purchase_applications
      SET status = 'pending_approval', current_node_index = 0, current_auditor_id = ?,
          rule_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(firstAuditorId, rule.id, applicationId);

    updateMaterialStatusOnSubmit(applicationId);

    if (oldStatus === 'returned') {
      markReturnRequirementsAsCompleted(applicationId, userId);
    }

    logOperation(applicationId, userId, '提交申请', 'submit', oldStatus, 'pending_approval',
      oldStatus === 'returned'
        ? `重新提交申请（已补充材料），按规则【${rule.name}】进入审批流程`
        : `提交申请，按规则【${rule.name}】进入审批流程`);
  });

  tx();
  return { success: true, ruleId: rule.id };
}

function approveApplication(applicationId, userId, comment) {
  const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(applicationId);
  if (!app) throw new Error('采购申请不存在');
  if (app.status === 'closed') throw new Error('申请已关闭，无法继续审批');
  if (app.status !== 'pending_approval') throw new Error('当前状态不允许审批');

  const currentNode = getCurrentNode(applicationId);
  if (!currentNode) throw new Error('当前审批节点不存在');

  if (currentNode.assigned_auditor_id !== userId) {
    throw new Error('您不是当前节点的审核人，无权执行此操作');
  }

  const nodes = getAllNodesWithAuditors(applicationId);
  const rule = db.prepare('SELECT approval_levels FROM approval_rules WHERE id = ?').get(app.rule_id);
  const totalLevels = rule ? rule.approval_levels : Math.max(...nodes.map(n => n.node_index)) + 1;
  const currentIndex = app.current_node_index;

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE approval_nodes
      SET status = 'approved', action = 'approve', comment = ?, operated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(comment || '同意', currentNode.id);

    const nextIndex = currentIndex + 1;

    if (nextIndex >= totalLevels) {
      db.prepare(`
        UPDATE purchase_applications
        SET status = 'approved', current_node_index = ?, current_auditor_id = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(totalLevels, applicationId);

      updateMaterialStatusOnApprove(applicationId);
      logOperation(applicationId, userId, `第${currentIndex + 1}级审核`, 'approve', 'pending_approval', 'approved', comment || '全部审批通过');
    } else {
      const nextNodesSameLevel = nodes.filter(n => n.node_index === nextIndex);
      const nextNode = nextNodesSameLevel.length > 0
        ? nextNodesSameLevel[nextNodesSameLevel.length - 1]
        : nodes.find(n => n.node_index === nextIndex);
      db.prepare(`
        UPDATE purchase_applications
        SET current_node_index = ?, current_auditor_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(nextIndex, nextNode.assigned_auditor_id, applicationId);

      logOperation(applicationId, userId, `第${currentIndex + 1}级审核`, 'approve', 'pending_approval', 'pending_approval', (comment || '同意') + `，流转至第${nextIndex + 1}级审核`);
    }
  });

  tx();
  return { success: true };
}

function returnApplication(applicationId, userId, comment, materialRequirements) {
  const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(applicationId);
  if (!app) throw new Error('采购申请不存在');
  if (app.status === 'closed') throw new Error('申请已关闭，无法退回');
  if (app.status !== 'pending_approval') throw new Error('当前状态不允许退回操作');

  const currentNode = getCurrentNode(applicationId);
  if (!currentNode) throw new Error('当前审批节点不存在');

  if (currentNode.assigned_auditor_id !== userId) {
    throw new Error('您不是当前节点的审核人，无权执行此操作');
  }

  if (!comment || comment.trim() === '') {
    throw new Error('退回必须填写退回原因');
  }

  const currentIndex = app.current_node_index;

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE approval_nodes
      SET status = 'returned', action = 'return', comment = ?, operated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(comment, currentNode.id);

    db.prepare(`
      UPDATE purchase_applications
      SET status = 'returned', current_node_index = 0, current_auditor_id = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(applicationId);

    updateMaterialStatusOnReturn(applicationId);
    logOperation(applicationId, userId, `第${currentIndex + 1}级审核`, 'return', 'pending_approval', 'returned', comment);
  });

  tx();

  if (materialRequirements && Array.isArray(materialRequirements) && materialRequirements.length > 0) {
    addReturnMaterialRequirements(applicationId, userId, materialRequirements, comment);
  }

  return { success: true };
}

function transferApplication(applicationId, userId, targetAuditorId, comment) {
  const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(applicationId);
  if (!app) throw new Error('采购申请不存在');
  if (app.status === 'closed') throw new Error('申请已关闭，无法转交');
  if (app.status !== 'pending_approval') throw new Error('当前状态不允许转交操作');

  const currentNode = getCurrentNode(applicationId);
  if (!currentNode) throw new Error('当前审批节点不存在');

  if (currentNode.assigned_auditor_id !== userId) {
    throw new Error('您不是当前节点的审核人，无权执行此操作');
  }

  const targetAuditor = db.prepare('SELECT id, role FROM users WHERE id = ? AND role = ?').get(targetAuditorId, 'auditor');
  if (!targetAuditor) {
    throw new Error('转交目标用户不存在或不是审核员');
  }

  if (parseInt(targetAuditorId) === parseInt(userId)) {
    throw new Error('不能转交给自己');
  }

  const currentIndex = app.current_node_index;

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE approval_nodes
      SET status = 'transferred', action = 'transfer', comment = ?, operated_at = CURRENT_TIMESTAMP,
          previous_auditor_id = ?, transferred_to_id = ?
      WHERE id = ?
    `).run(comment || '转交审核', userId, targetAuditorId, currentNode.id);

    db.prepare(`
      INSERT INTO approval_nodes (application_id, node_index, auditor_id, assigned_auditor_id, status, previous_auditor_id)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(applicationId, currentIndex, currentNode.auditor_id, targetAuditorId, userId);

    db.prepare(`
      UPDATE purchase_applications
      SET current_auditor_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(targetAuditorId, applicationId);

    const targetUser = db.prepare('SELECT real_name FROM users WHERE id = ?').get(targetAuditorId);
    logOperation(applicationId, userId, `第${currentIndex + 1}级审核`, 'transfer', 'pending_approval', 'pending_approval',
      (comment || '转交审核') + `，转交给审核员【${targetUser ? targetUser.real_name : ''}】`);
  });

  tx();
  return { success: true };
}

function closeApplication(applicationId, userId, comment) {
  const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(applicationId);
  if (!app) throw new Error('采购申请不存在');
  if (app.status === 'closed') throw new Error('申请已经是关闭状态');
  if (app.status === 'arrival_confirmed') throw new Error('已完成到货确认的申请无需关闭');

  const currentNode = getCurrentNode(applicationId);
  let canClose = false;

  if (currentNode && currentNode.assigned_auditor_id === userId) {
    canClose = true;
  }
  if (app.applicant_id === userId) {
    canClose = true;
  }

  if (!canClose) {
    throw new Error('只有申请人或当前审核人可以关闭申请');
  }

  if (!comment || comment.trim() === '') {
    throw new Error('关闭申请必须填写关闭原因');
  }

  const tx = db.transaction(() => {
    if (app.status === 'pending_approval' && currentNode) {
      db.prepare(`
        UPDATE approval_nodes
        SET status = 'skipped', action = 'close', comment = ?, operated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(comment, currentNode.id);
    }

    const oldStatus = app.status;
    db.prepare(`
      UPDATE purchase_applications
      SET status = 'closed', current_auditor_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(applicationId);

    logOperation(applicationId, userId, '关闭申请', 'close', oldStatus, 'closed', comment);
  });

  tx();
  return { success: true };
}

function resubmitApplication(applicationId, userId) {
  const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(applicationId);
  if (!app) throw new Error('采购申请不存在');
  if (app.status !== 'returned') throw new Error('只有退回状态的申请可以重新提交');

  if (app.applicant_id !== userId) {
    throw new Error('只有申请人本人可以重新提交申请');
  }

  if (app.urgency_level === 'urgent' && (!app.urgent_reason || app.urgent_reason.trim() === '')) {
    throw new Error('紧急申请必须填写紧急原因');
  }

  return submitApplication(applicationId, userId);
}

function confirmArrival(applicationId, userId, arrivalInfo, comment) {
  const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(applicationId);
  if (!app) throw new Error('采购申请不存在');
  if (app.status !== 'approved') throw new Error('只有审批通过的申请才能确认到货');

  if (app.applicant_id !== userId) {
    throw new Error('只有申请人本人可以确认到货');
  }

  if (!arrivalInfo || !arrivalInfo.items || arrivalInfo.items.length === 0) {
    throw new Error('请填写到货明细');
  }

  const tx = db.transaction(() => {
    const oldStatus = app.status;
    db.prepare(`
      UPDATE purchase_applications
      SET status = 'arrival_confirmed', arrival_info = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(arrivalInfo), applicationId);

    logOperation(applicationId, userId, '到货确认', 'confirm_arrival', oldStatus, 'arrival_confirmed', comment || '已完成到货确认');
  });

  tx();
  return { success: true };
}

function updateQuoteDescription(applicationId, userId, quoteDescription) {
  const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(applicationId);
  if (!app) throw new Error('采购申请不存在');
  if (app.status === 'closed' || app.status === 'arrival_confirmed' || app.status === 'approved') {
    throw new Error('当前状态不允许修改报价说明');
  }

  if (app.applicant_id !== userId) {
    throw new Error('只有申请人本人可以修改报价说明');
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE purchase_applications
      SET quote_description = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(quoteDescription, applicationId);

    logOperation(applicationId, userId, '补充报价说明', 'update_quote', app.status, app.status, '补充或更新了报价说明');
  });

  tx();
  return { success: true };
}

function logMaterialChange(materialId, applicationId, userId, changeType, fieldChanged, oldValue, newValue, changeReason, version) {
  db.prepare(`
    INSERT INTO material_change_logs
    (material_id, application_id, user_id, change_type, field_changed, old_value, new_value, change_reason, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(materialId, applicationId, userId, changeType, fieldChanged || null, oldValue || null, newValue || null, changeReason || null, version || 1);
}

function addMaterial(applicationId, userId, materialData) {
  const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(applicationId);
  if (!app) throw new Error('采购申请不存在');

  if (app.status === 'closed' || app.status === 'arrival_confirmed' || app.status === 'approved') {
    throw new Error('当前状态不允许维护材料信息');
  }

  if (app.status === 'pending_approval') {
    throw new Error('申请正在审批中，无法维护材料，请先联系审核人退回');
  }

  if (app.applicant_id !== userId) {
    throw new Error('只有申请人本人可以维护材料信息');
  }

  const { material_name, material_type = 'other', description, attachment_url, voucher_url, sort_order = 0 } = materialData;

  if (!material_name || material_name.trim() === '') {
    throw new Error('材料名称不能为空');
  }

  const validTypes = ['contract', 'quote', 'invoice', 'receipt', 'certificate', 'approval', 'specification', 'drawing', 'other'];
  if (!validTypes.includes(material_type)) {
    throw new Error(`材料类型只能是以下之一：${validTypes.join('、')}`);
  }

  let materialId;
  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO application_materials
      (application_id, material_name, material_type, description, attachment_url, voucher_url, status, sort_order, version, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(applicationId, material_name, material_type, description || null, attachment_url || null, voucher_url || null,
      app.status === 'returned' ? 'supplemented' : 'pending', sort_order, userId);

    materialId = result.lastInsertRowid;

    logMaterialChange(materialId, applicationId, userId, 'create', null, null, JSON.stringify(materialData), '新增材料', 1);
    logOperation(applicationId, userId, '材料管理', 'material_add', app.status, app.status, `新增材料：${material_name}`);
  });

  tx();
  return db.prepare('SELECT * FROM application_materials WHERE id = ?').get(materialId);
}

function updateMaterial(materialId, userId, materialData) {
  const material = db.prepare('SELECT * FROM application_materials WHERE id = ?').get(materialId);
  if (!material) throw new Error('材料不存在');

  const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(material.application_id);
  if (!app) throw new Error('采购申请不存在');

  if (app.status === 'closed' || app.status === 'arrival_confirmed' || app.status === 'approved') {
    throw new Error('当前状态不允许修改材料信息');
  }

  if (app.status === 'pending_approval') {
    throw new Error('申请正在审批中，无法修改材料，请先联系审核人退回');
  }

  if (material.created_by !== userId) {
    throw new Error('只有材料创建人可以修改材料信息');
  }

  const validTypes = ['contract', 'quote', 'invoice', 'receipt', 'certificate', 'approval', 'specification', 'drawing', 'other'];
  if (materialData.material_type && !validTypes.includes(materialData.material_type)) {
    throw new Error(`材料类型只能是以下之一：${validTypes.join('、')}`);
  }

  const updates = [];
  const values = [];
  const changeDetails = [];

  const fields = [
    { key: 'material_name', label: '材料名称' },
    { key: 'material_type', label: '材料类型' },
    { key: 'description', label: '材料说明' },
    { key: 'attachment_url', label: '附件地址' },
    { key: 'voucher_url', label: '凭证链接' },
    { key: 'sort_order', label: '排序' }
  ];

  fields.forEach(({ key, label }) => {
    if (materialData[key] !== undefined) {
      const oldVal = material[key];
      const newVal = materialData[key];
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        updates.push(`${key} = ?`);
        values.push(newVal);
        logMaterialChange(materialId, material.application_id, userId, 'update', label,
          oldVal !== null && typeof oldVal !== 'undefined' ? String(oldVal) : null,
          newVal !== null && typeof newVal !== 'undefined' ? String(newVal) : null,
          `修改${label}`, material.version);
        changeDetails.push(`${label}: ${oldVal ?? '(空)'} → ${newVal ?? '(空)'}`);
      }
    }
  });

  if (updates.length === 0) {
    return material;
  }

  const newVersion = material.version + 1;
  updates.push('version = ?');
  values.push(newVersion);
  updates.push('status = ?');
  values.push(app.status === 'returned' ? 'supplemented' : 'pending');
  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(materialId);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE application_materials SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    logOperation(material.application_id, userId, '材料管理', 'material_update', app.status, app.status,
      `修改材料【${material.material_name}】：${changeDetails.join('；')}`);
  });

  tx();
  return db.prepare('SELECT * FROM application_materials WHERE id = ?').get(materialId);
}

function deleteMaterial(materialId, userId) {
  const material = db.prepare('SELECT * FROM application_materials WHERE id = ?').get(materialId);
  if (!material) throw new Error('材料不存在');

  const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(material.application_id);
  if (!app) throw new Error('采购申请不存在');

  if (app.status === 'closed' || app.status === 'arrival_confirmed' || app.status === 'approved') {
    throw new Error('当前状态不允许删除材料');
  }

  if (app.status === 'pending_approval') {
    throw new Error('申请正在审批中，无法删除材料，请先联系审核人退回');
  }

  if (material.created_by !== userId) {
    throw new Error('只有材料创建人可以删除材料');
  }

  const tx = db.transaction(() => {
    logMaterialChange(materialId, material.application_id, userId, 'delete', null, JSON.stringify(material), null, '删除材料', material.version);
    db.prepare('DELETE FROM application_materials WHERE id = ?').run(materialId);
    logOperation(material.application_id, userId, '材料管理', 'material_delete', app.status, app.status,
      `删除材料：${material.material_name}`);
  });

  tx();
  return { success: true };
}

function getMaterialsByApplication(applicationId) {
  const materials = db.prepare(`
    SELECT am.*, u.real_name as creator_name, u.username as creator_username
    FROM application_materials am
    LEFT JOIN users u ON am.created_by = u.id
    WHERE am.application_id = ?
    ORDER BY am.sort_order, am.id
  `).all(applicationId);
  return materials;
}

function getMaterialChangeLogs(materialId) {
  const logs = db.prepare(`
    SELECT mcl.*, u.real_name as user_name, u.username as user_username
    FROM material_change_logs mcl
    LEFT JOIN users u ON mcl.user_id = u.id
    WHERE mcl.material_id = ?
    ORDER BY mcl.created_at ASC, mcl.id ASC
  `).all(materialId);
  return logs;
}

function getAllMaterialChangeLogs(applicationId) {
  const logs = db.prepare(`
    SELECT mcl.*, u.real_name as user_name, u.username as user_username,
           am.material_name
    FROM material_change_logs mcl
    LEFT JOIN users u ON mcl.user_id = u.id
    LEFT JOIN application_materials am ON mcl.material_id = am.id
    WHERE mcl.application_id = ?
    ORDER BY mcl.created_at ASC, mcl.id ASC
  `).all(applicationId);
  return logs;
}

function addReturnMaterialRequirements(applicationId, auditorId, requirements, returnComment) {
  const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(applicationId);
  if (!app) throw new Error('采购申请不存在');

  if (!requirements || !Array.isArray(requirements) || requirements.length === 0) {
    return [];
  }

  const validReqTypes = ['supplement', 'modify', 'delete', 'replace'];

  const tx = db.transaction(() => {
    const insertReq = db.prepare(`
      INSERT INTO return_material_requirements
      (application_id, material_id, auditor_id, requirement_type, required_material_name, required_material_type, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    requirements.forEach(req => {
      if (!req.description || req.description.trim() === '') {
        throw new Error('材料补充要求描述不能为空');
      }
      const reqType = req.requirement_type || 'supplement';
      if (!validReqTypes.includes(reqType)) {
        throw new Error(`要求类型只能是以下之一：${validReqTypes.join('、')}`);
      }
      insertReq.run(
        applicationId,
        req.material_id || null,
        auditorId,
        reqType,
        req.required_material_name || null,
        req.required_material_type || null,
        req.description
      );
    });

    logOperation(applicationId, auditorId, '退回审核', 'return_with_requirements', 'pending_approval', 'returned',
      `退回申请并指定材料补充要求（共${requirements.length}项）：${returnComment || ''}`);
  });

  tx();
  return getReturnMaterialRequirements(applicationId);
}

function getReturnMaterialRequirements(applicationId) {
  return db.prepare(`
    SELECT rmr.*, u.real_name as auditor_name, u.username as auditor_username,
           cu.real_name as completer_name, cu.username as completer_username,
           am.material_name as related_material_name, am.material_type as related_material_type
    FROM return_material_requirements rmr
    LEFT JOIN users u ON rmr.auditor_id = u.id
    LEFT JOIN users cu ON rmr.completed_by = cu.id
    LEFT JOIN application_materials am ON rmr.material_id = am.id
    WHERE rmr.application_id = ?
    ORDER BY rmr.created_at ASC, rmr.id ASC
  `).all(applicationId);
}

function markReturnRequirementsAsCompleted(applicationId, userId) {
  const pendingReqs = db.prepare(`
    SELECT * FROM return_material_requirements
    WHERE application_id = ? AND is_completed = 0
  `).all(applicationId);

  if (pendingReqs.length === 0) return;

  const tx = db.transaction(() => {
    const updateStmt = db.prepare(`
      UPDATE return_material_requirements
      SET is_completed = 1, completed_at = CURRENT_TIMESTAMP, completed_by = ?
      WHERE application_id = ? AND is_completed = 0
    `);
    updateStmt.run(userId, applicationId);
  });

  tx();
}

function updateMaterialStatusOnSubmit(applicationId) {
  const stmt = db.prepare(`
    UPDATE application_materials
    SET status = 'submitted', updated_at = CURRENT_TIMESTAMP
    WHERE application_id = ? AND status IN ('pending', 'supplemented', 'returned')
  `);
  stmt.run(applicationId);
}

function updateMaterialStatusOnReturn(applicationId) {
  const stmt = db.prepare(`
    UPDATE application_materials
    SET status = 'returned', updated_at = CURRENT_TIMESTAMP
    WHERE application_id = ? AND status = 'submitted'
  `);
  stmt.run(applicationId);
}

function updateMaterialStatusOnApprove(applicationId) {
  const stmt = db.prepare(`
    UPDATE application_materials
    SET status = 'approved', updated_at = CURRENT_TIMESTAMP
    WHERE application_id = ? AND status IN ('submitted', 'returned', 'supplemented', 'pending')
  `);
  stmt.run(applicationId);
}

function getMaterialTypeDict() {
  return [
    { value: 'contract', label: '合同/协议' },
    { value: 'quote', label: '报价单/比价单' },
    { value: 'invoice', label: '发票' },
    { value: 'receipt', label: '收据/付款凭证' },
    { value: 'certificate', label: '资质证书' },
    { value: 'approval', label: '审批文件' },
    { value: 'specification', label: '技术规格书' },
    { value: 'drawing', label: '图纸/设计文件' },
    { value: 'other', label: '其他' }
  ];
}

function getMaterialStatusDict() {
  return [
    { value: 'pending', label: '待提交', color: 'default' },
    { value: 'submitted', label: '已提交', color: 'primary' },
    { value: 'returned', label: '被退回', color: 'danger' },
    { value: 'supplemented', label: '已补充', color: 'warning' },
    { value: 'approved', label: '已通过', color: 'success' }
  ];
}

function getRequirementTypeDict() {
  return [
    { value: 'supplement', label: '补充材料' },
    { value: 'modify', label: '修改材料' },
    { value: 'delete', label: '删除材料' },
    { value: 'replace', label: '替换材料' }
  ];
}

module.exports = {
  generateApplicationNo,
  findApprovalRule,
  createApprovalNodes,
  logOperation,
  getCurrentNode,
  getAllNodesWithAuditors,
  submitApplication,
  approveApplication,
  returnApplication,
  transferApplication,
  closeApplication,
  resubmitApplication,
  confirmArrival,
  updateQuoteDescription,
  logMaterialChange,
  addMaterial,
  updateMaterial,
  deleteMaterial,
  getMaterialsByApplication,
  getMaterialChangeLogs,
  getAllMaterialChangeLogs,
  addReturnMaterialRequirements,
  getReturnMaterialRequirements,
  markReturnRequirementsAsCompleted,
  updateMaterialStatusOnSubmit,
  updateMaterialStatusOnReturn,
  updateMaterialStatusOnApprove,
  getMaterialTypeDict,
  getMaterialStatusDict,
  getRequirementTypeDict
};
