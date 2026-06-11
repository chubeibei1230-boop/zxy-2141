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

    logOperation(applicationId, userId, '提交申请', 'submit', oldStatus, 'pending_approval', `提交申请，按规则【${rule.name}】进入审批流程`);
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

function returnApplication(applicationId, userId, comment) {
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

    logOperation(applicationId, userId, `第${currentIndex + 1}级审核`, 'return', 'pending_approval', 'returned', comment);
  });

  tx();
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
  updateQuoteDescription
};
