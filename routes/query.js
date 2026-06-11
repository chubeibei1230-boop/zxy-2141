const express = require('express');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const {
  getAllNodesWithAuditors,
  getMaterialsByApplication,
  getMaterialChangeLogs,
  getAllMaterialChangeLogs,
  getReturnMaterialRequirements,
  getMaterialTypeDict,
  getMaterialStatusDict,
  getRequirementTypeDict
} = require('../services/approvalEngine');

const router = express.Router();

router.use(authMiddleware);

const STATUS_MAP = {
  draft: '草稿',
  pending_approval: '审批中',
  returned: '已退回',
  approved: '审批通过',
  rejected: '已拒绝',
  arrival_confirmed: '已到货',
  closed: '已关闭'
};

const URGENCY_MAP = {
  normal: '普通',
  high: '高优先级',
  urgent: '紧急'
};

function buildQueryConditions(query, userId, userRole) {
  const conditions = [];
  const params = [];

  const {
    department_id, budget_subject_id, applicant_id,
    current_auditor_id, status, date_from, date_to,
    min_amount, max_amount, urgency_level, keyword,
    my_created, my_pending, my_related
  } = query;

  if (department_id) {
    conditions.push('pa.department_id = ?');
    params.push(department_id);
  }

  if (budget_subject_id) {
    const subject = db.prepare('SELECT id FROM budget_subjects WHERE id = ?').get(budget_subject_id);
    if (subject) {
      const childSubjects = db.prepare(`
        WITH RECURSIVE subject_tree AS (
          SELECT id FROM budget_subjects WHERE id = ?
          UNION ALL
          SELECT s.id FROM budget_subjects s
          INNER JOIN subject_tree t ON s.parent_id = t.id
        )
        SELECT id FROM subject_tree
      `).all(budget_subject_id).map(s => s.id);
      conditions.push(`pa.budget_subject_id IN (${childSubjects.map(() => '?').join(',')})`);
      params.push(...childSubjects);
    }
  }

  if (applicant_id) {
    conditions.push('pa.applicant_id = ?');
    params.push(applicant_id);
  }

  if (current_auditor_id) {
    conditions.push('pa.current_auditor_id = ?');
    params.push(current_auditor_id);
  }

  if (status) {
    if (Array.isArray(status)) {
      conditions.push(`pa.status IN (${status.map(() => '?').join(',')})`);
      params.push(...status);
    } else {
      conditions.push('pa.status = ?');
      params.push(status);
    }
  }

  if (date_from) {
    conditions.push('DATE(pa.created_at) >= DATE(?)');
    params.push(date_from);
  }

  if (date_to) {
    conditions.push('DATE(pa.created_at) <= DATE(?)');
    params.push(date_to);
  }

  if (min_amount !== undefined && min_amount !== '') {
    conditions.push('pa.total_amount >= ?');
    params.push(parseFloat(min_amount));
  }

  if (max_amount !== undefined && max_amount !== '') {
    conditions.push('pa.total_amount <= ?');
    params.push(parseFloat(max_amount));
  }

  if (urgency_level) {
    conditions.push('pa.urgency_level = ?');
    params.push(urgency_level);
  }

  if (keyword) {
    conditions.push('(pa.title LIKE ? OR pa.application_no LIKE ?)');
    const kw = `%${keyword}%`;
    params.push(kw, kw);
  }

  if (my_created === 'true' || my_created === '1') {
    conditions.push('pa.applicant_id = ?');
    params.push(userId);
  }

  if (my_pending === 'true' || my_pending === '1') {
    conditions.push('pa.current_auditor_id = ? AND pa.status = ?');
    params.push(userId, 'pending_approval');
  }

  if (my_related === 'true' || my_related === '1') {
    conditions.push('(pa.applicant_id = ? OR pa.current_auditor_id = ?)');
    params.push(userId, userId);
  }

  return { conditions: conditions.length ? conditions.join(' AND ') : '1=1', params };
}

router.get('/applications', (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.page_size) || 20;
    const offset = (page - 1) * pageSize;

    const { conditions, params } = buildQueryConditions(req.query, req.user.id, req.user.role);

    const baseSql = `
      FROM purchase_applications pa
      LEFT JOIN budget_subjects bs ON pa.budget_subject_id = bs.id
      LEFT JOIN suppliers s ON pa.supplier_id = s.id
      LEFT JOIN users u ON pa.applicant_id = u.id
      LEFT JOIN departments d ON pa.department_id = d.id
      LEFT JOIN users cau ON pa.current_auditor_id = cau.id
      LEFT JOIN approval_rules ar ON pa.rule_id = ar.id
      WHERE ${conditions}
    `;

    const countSql = `SELECT COUNT(*) as total ${baseSql}`;
    const { total } = db.prepare(countSql).get(...params);

    const listSql = `
      SELECT pa.id, pa.application_no, pa.title, pa.total_amount, pa.status,
             pa.urgency_level, pa.current_node_index,
             pa.created_at, pa.updated_at,
             bs.name as budget_subject_name, bs.code as budget_subject_code,
             s.name as supplier_name,
             u.real_name as applicant_name,
             d.name as department_name,
             cau.real_name as current_auditor_name,
             ar.name as rule_name, ar.approval_levels
      ${baseSql}
      ORDER BY pa.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const list = db.prepare(listSql).all(...params, pageSize, offset).map(item => ({
      ...item,
      status_name: STATUS_MAP[item.status] || item.status,
      urgency_name: URGENCY_MAP[item.urgency_level] || item.urgency_level
    }));

    res.json({
      success: true,
      data: {
        list,
        pagination: {
          page,
          page_size: pageSize,
          total,
          total_pages: Math.ceil(total / pageSize)
        }
      }
    });
  } catch (err) {
    console.error('查询申请列表错误:', err);
    res.status(500).json({ success: false, message: '查询失败：' + err.message });
  }
});

router.get('/applications/:id', (req, res) => {
  try {
    const { id } = req.params;

    const app = db.prepare(`
      SELECT pa.*,
             bs.name as budget_subject_name, bs.code as budget_subject_code,
             s.name as supplier_name, s.code as supplier_code,
             s.contact_person as supplier_contact, s.contact_phone as supplier_phone,
             u.real_name as applicant_name, u.username as applicant_username,
             u.email as applicant_email, u.phone as applicant_phone,
             d.name as department_name, d.code as department_code,
             ar.name as rule_name, ar.approval_levels, ar.description as rule_description,
             cau.real_name as current_auditor_name, cau.username as current_auditor_username
      FROM purchase_applications pa
      LEFT JOIN budget_subjects bs ON pa.budget_subject_id = bs.id
      LEFT JOIN suppliers s ON pa.supplier_id = s.id
      LEFT JOIN users u ON pa.applicant_id = u.id
      LEFT JOIN departments d ON pa.department_id = d.id
      LEFT JOIN approval_rules ar ON pa.rule_id = ar.id
      LEFT JOIN users cau ON pa.current_auditor_id = cau.id
      WHERE pa.id = ?
    `).get(id);

    if (!app) {
      return res.status(404).json({ success: false, message: '采购申请不存在' });
    }

    app.items = JSON.parse(app.items);
    if (app.arrival_info) app.arrival_info = JSON.parse(app.arrival_info);

    app.status_name = STATUS_MAP[app.status] || app.status;
    app.urgency_name = URGENCY_MAP[app.urgency_level] || app.urgency_level;
    app.approval_nodes = getAllNodesWithAuditors(id);

    const logs = db.prepare(`
      SELECT ol.*, u.real_name as user_name, u.username as user_username
      FROM operation_logs ol
      LEFT JOIN users u ON ol.user_id = u.id
      WHERE ol.application_id = ?
      ORDER BY ol.created_at ASC, ol.id ASC
    `).all(id);

    app.operation_logs = logs;

    const rawMaterials = getMaterialsByApplication(id);
    const statusDict = getMaterialStatusDict();
    const typeDict = getMaterialTypeDict();
    const statusMap = {};
    const typeMap = {};
    statusDict.forEach(s => statusMap[s.value] = s.label);
    typeDict.forEach(t => typeMap[t.value] = t.label);
    app.materials = rawMaterials.map(m => ({
      ...m,
      material_type_name: typeMap[m.material_type] || m.material_type,
      status_name: statusMap[m.status] || m.status
    }));

    app.material_change_logs = getAllMaterialChangeLogs(id);

    const rawReqs = getReturnMaterialRequirements(id);
    const reqTypeMap = {
      supplement: '补充材料',
      modify: '修改材料',
      delete: '删除材料',
      replace: '替换材料'
    };
    app.return_material_requirements = rawReqs.map(r => ({
      ...r,
      requirement_type_name: reqTypeMap[r.requirement_type] || r.requirement_type
    }));

    const materialStats = {
      total: app.materials.length,
      pending: app.materials.filter(m => m.status === 'pending').length,
      submitted: app.materials.filter(m => m.status === 'submitted').length,
      returned: app.materials.filter(m => m.status === 'returned').length,
      supplemented: app.materials.filter(m => m.status === 'supplemented').length,
      approved: app.materials.filter(m => m.status === 'approved').length,
      total_requirements: app.return_material_requirements.length,
      completed_requirements: app.return_material_requirements.filter(r => r.is_completed === 1).length,
      pending_requirements: app.return_material_requirements.filter(r => r.is_completed === 0).length
    };
    app.material_summary = materialStats;

    res.json({ success: true, data: app });
  } catch (err) {
    console.error('查询申请详情错误:', err);
    res.status(500).json({ success: false, message: '查询失败：' + err.message });
  }
});

router.get('/applications/:id/logs', (req, res) => {
  try {
    const logs = db.prepare(`
      SELECT ol.*, u.real_name as user_name, u.username as user_username
      FROM operation_logs ol
      LEFT JOIN users u ON ol.user_id = u.id
      WHERE ol.application_id = ?
      ORDER BY ol.created_at ASC, ol.id ASC
    `).all(req.params.id);

    res.json({ success: true, data: logs });
  } catch (err) {
    console.error('查询操作日志错误:', err);
    res.status(500).json({ success: false, message: '查询日志失败：' + err.message });
  }
});

router.get('/applications/:id/nodes', (req, res) => {
  try {
    const nodes = getAllNodesWithAuditors(req.params.id);
    res.json({ success: true, data: nodes });
  } catch (err) {
    console.error('查询审批节点错误:', err);
    res.status(500).json({ success: false, message: '查询审批节点失败：' + err.message });
  }
});

router.get('/public/budget-subjects', (req, res) => {
  try {
    const { status } = req.query;
    let sql = `
      SELECT bs.*, p.name as parent_name, p.code as parent_code
      FROM budget_subjects bs
      LEFT JOIN budget_subjects p ON bs.parent_id = p.id
      WHERE 1=1
    `;
    const params = [];
    if (status !== undefined) {
      sql += ' AND bs.status = ?';
      params.push(parseInt(status));
    }
    sql += ' ORDER BY bs.code';

    const subjects = db.prepare(sql).all(...params);

    const buildTree = (items, parentId = null) => {
      return items
        .filter(item => (item.parent_id === null && parentId === null) || item.parent_id === parentId)
        .map(item => ({
          ...item,
          children: buildTree(items, item.id)
        }));
    };

    res.json({
      success: true,
      data: {
        list: subjects,
        tree: buildTree(subjects)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: '查询失败：' + err.message });
  }
});

router.get('/public/suppliers', (req, res) => {
  try {
    let sql = 'SELECT * FROM suppliers WHERE status = 1';
    const params = [];
    if (req.query.keyword) {
      sql += ' AND (name LIKE ? OR code LIKE ?)';
      const kw = `%${req.query.keyword}%`;
      params.push(kw, kw);
    }
    sql += ' ORDER BY code';
    const suppliers = db.prepare(sql).all(...params);
    res.json({ success: true, data: suppliers });
  } catch (err) {
    res.status(500).json({ success: false, message: '查询失败：' + err.message });
  }
});

router.get('/public/departments', (req, res) => {
  try {
    const departments = db.prepare('SELECT * FROM departments ORDER BY code').all();
    res.json({ success: true, data: departments });
  } catch (err) {
    res.status(500).json({ success: false, message: '查询失败：' + err.message });
  }
});

router.get('/public/approval-rules/match', (req, res) => {
  try {
    const { budget_subject_id, amount, urgency_level } = req.query;
    const { findApprovalRule } = require('../services/approvalEngine');

    if (!amount || !urgency_level) {
      return res.status(400).json({ success: false, message: '金额和紧急程度为必填参数' });
    }

    const rule = findApprovalRule(
      budget_subject_id || null,
      parseFloat(amount),
      urgency_level
    );

    if (!rule) {
      return res.json({ success: true, data: null, message: '未找到匹配的审批规则' });
    }

    const auditors = db.prepare(
      `SELECT id, username, real_name FROM users WHERE id IN (${JSON.parse(rule.auditor_ids).map(() => '?').join(',')})`
    ).all(...JSON.parse(rule.auditor_ids));

    rule.auditor_list = JSON.parse(rule.auditor_ids).map(id => auditors.find(a => a.id === id)).filter(Boolean);

    res.json({ success: true, data: rule });
  } catch (err) {
    console.error('匹配规则错误:', err);
    res.status(500).json({ success: false, message: '匹配规则失败：' + err.message });
  }
});

router.get('/applications/:id/materials', (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(id);
    if (!app) {
      return res.status(404).json({ success: false, message: '采购申请不存在' });
    }

    if (userRole !== 'admin' && app.applicant_id !== userId && app.current_auditor_id !== userId) {
      const isRelatedAuditor = db.prepare(`
        SELECT 1 FROM approval_nodes an
        JOIN users u ON (an.auditor_id = u.id OR an.assigned_auditor_id = u.id)
        WHERE an.application_id = ? AND u.id = ?
        LIMIT 1
      `).get(id, userId);
      if (!isRelatedAuditor) {
        return res.status(403).json({ success: false, message: '您无权查看此申请的材料信息' });
      }
    }

    const materials = getMaterialsByApplication(id);
    const statusDict = getMaterialStatusDict();
    const typeDict = getMaterialTypeDict();
    const statusMap = {};
    const typeMap = {};
    statusDict.forEach(s => statusMap[s.value] = s.label);
    typeDict.forEach(t => typeMap[t.value] = t.label);

    const materialsWithLabels = materials.map(m => ({
      ...m,
      material_type_name: typeMap[m.material_type] || m.material_type,
      status_name: statusMap[m.status] || m.status
    }));

    res.json({ success: true, data: materialsWithLabels });
  } catch (err) {
    console.error('查询材料清单错误:', err);
    res.status(500).json({ success: false, message: '查询材料清单失败：' + err.message });
  }
});

router.get('/applications/:id/material-change-logs', (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(id);
    if (!app) {
      return res.status(404).json({ success: false, message: '采购申请不存在' });
    }

    if (userRole !== 'admin' && app.applicant_id !== userId && app.current_auditor_id !== userId) {
      const isRelatedAuditor = db.prepare(`
        SELECT 1 FROM approval_nodes an
        JOIN users u ON (an.auditor_id = u.id OR an.assigned_auditor_id = u.id)
        WHERE an.application_id = ? AND u.id = ?
        LIMIT 1
      `).get(id, userId);
      if (!isRelatedAuditor) {
        return res.status(403).json({ success: false, message: '您无权查看此申请的材料变更记录' });
      }
    }

    const logs = getAllMaterialChangeLogs(id);
    res.json({ success: true, data: logs });
  } catch (err) {
    console.error('查询材料变更记录错误:', err);
    res.status(500).json({ success: false, message: '查询失败：' + err.message });
  }
});

router.get('/applications/:id/return-requirements', (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(id);
    if (!app) {
      return res.status(404).json({ success: false, message: '采购申请不存在' });
    }

    if (userRole !== 'admin' && app.applicant_id !== userId && app.current_auditor_id !== userId) {
      const isRelatedAuditor = db.prepare(`
        SELECT 1 FROM approval_nodes an
        JOIN users u ON (an.auditor_id = u.id OR an.assigned_auditor_id = u.id)
        WHERE an.application_id = ? AND u.id = ?
        LIMIT 1
      `).get(id, userId);
      if (!isRelatedAuditor) {
        return res.status(403).json({ success: false, message: '您无权查看此申请的退回材料要求' });
      }
    }

    const requirements = getReturnMaterialRequirements(id);
    const reqTypeMap = {
      supplement: '补充材料',
      modify: '修改材料',
      delete: '删除材料',
      replace: '替换材料'
    };
    const data = requirements.map(r => ({
      ...r,
      requirement_type_name: reqTypeMap[r.requirement_type] || r.requirement_type
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('查询退回材料要求错误:', err);
    res.status(500).json({ success: false, message: '查询失败：' + err.message });
  }
});

router.get('/materials/:materialId/changes', (req, res) => {
  try {
    const { materialId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const material = db.prepare('SELECT * FROM application_materials WHERE id = ?').get(materialId);
    if (!material) {
      return res.status(404).json({ success: false, message: '材料不存在' });
    }

    const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(material.application_id);
    if (userRole !== 'admin' && app.applicant_id !== userId && app.current_auditor_id !== userId) {
      const isRelatedAuditor = db.prepare(`
        SELECT 1 FROM approval_nodes an
        JOIN users u ON (an.auditor_id = u.id OR an.assigned_auditor_id = u.id)
        WHERE an.application_id = ? AND u.id = ?
        LIMIT 1
      `).get(material.application_id, userId);
      if (!isRelatedAuditor) {
        return res.status(403).json({ success: false, message: '您无权查看此材料的变更记录' });
      }
    }

    const logs = getMaterialChangeLogs(parseInt(materialId));
    res.json({ success: true, data: logs });
  } catch (err) {
    console.error('查询材料变更记录错误:', err);
    res.status(500).json({ success: false, message: '查询失败：' + err.message });
  }
});

router.get('/public/material-types', (req, res) => {
  res.json({ success: true, data: getMaterialTypeDict() });
});

router.get('/public/material-statuses', (req, res) => {
  res.json({ success: true, data: getMaterialStatusDict() });
});

router.get('/public/requirement-types', (req, res) => {
  res.json({ success: true, data: getRequirementTypeDict() });
});

module.exports = { router, STATUS_MAP, URGENCY_MAP };
