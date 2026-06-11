const express = require('express');
const { db } = require('../database');
const { authMiddleware, roleMiddleware } = require('../middleware/auth');
const {
  approveApplication,
  returnApplication,
  transferApplication,
  closeApplication,
  getAllNodesWithAuditors
} = require('../services/approvalEngine');

const router = express.Router();

router.use(authMiddleware, roleMiddleware('auditor', 'admin'));

router.post('/applications/:id/approve', (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { comment } = req.body;

    approveApplication(id, userId, comment);

    const app = db.prepare(`
      SELECT pa.*,
             bs.name as budget_subject_name, bs.code as budget_subject_code,
             s.name as supplier_name, s.code as supplier_code,
             u.real_name as applicant_name, u.username as applicant_username,
             d.name as department_name, d.code as department_code,
             ar.name as rule_name, ar.approval_levels,
             au.real_name as current_auditor_name
      FROM purchase_applications pa
      LEFT JOIN budget_subjects bs ON pa.budget_subject_id = bs.id
      LEFT JOIN suppliers s ON pa.supplier_id = s.id
      LEFT JOIN users u ON pa.applicant_id = u.id
      LEFT JOIN departments d ON pa.department_id = d.id
      LEFT JOIN approval_rules ar ON pa.rule_id = ar.id
      LEFT JOIN users au ON pa.current_auditor_id = au.id
      WHERE pa.id = ?
    `).get(id);

    app.items = JSON.parse(app.items);
    app.approval_nodes = getAllNodesWithAuditors(id);
    if (app.arrival_info) app.arrival_info = JSON.parse(app.arrival_info);

    const message = app.status === 'approved' ? '审批通过，申请已完成全部审批' : '审批通过，已流转至下一节点';
    res.json({ success: true, message, data: app });
  } catch (err) {
    console.error('审批通过错误:', err);
    res.status(400).json({ success: false, message: err.message });
  }
});

router.post('/applications/:id/return', (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { comment } = req.body;

    returnApplication(id, userId, comment);

    const app = db.prepare(`
      SELECT pa.*,
             bs.name as budget_subject_name, bs.code as budget_subject_code,
             s.name as supplier_name, s.code as supplier_code,
             u.real_name as applicant_name, u.username as applicant_username,
             d.name as department_name, d.code as department_code,
             ar.name as rule_name,
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

    app.items = JSON.parse(app.items);
    app.approval_nodes = getAllNodesWithAuditors(id);
    if (app.arrival_info) app.arrival_info = JSON.parse(app.arrival_info);

    res.json({ success: true, message: '已退回申请，请等待申请人补充材料后重新提交', data: app });
  } catch (err) {
    console.error('退回错误:', err);
    res.status(400).json({ success: false, message: err.message });
  }
});

router.post('/applications/:id/transfer', (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { target_auditor_id, comment } = req.body;

    if (!target_auditor_id) {
      return res.status(400).json({ success: false, message: '请选择转交目标审核员' });
    }

    transferApplication(id, userId, target_auditor_id, comment);

    const app = db.prepare(`
      SELECT pa.*,
             bs.name as budget_subject_name, bs.code as budget_subject_code,
             s.name as supplier_name, s.code as supplier_code,
             u.real_name as applicant_name, u.username as applicant_username,
             d.name as department_name, d.code as department_code,
             ar.name as rule_name,
             au.real_name as current_auditor_name
      FROM purchase_applications pa
      LEFT JOIN budget_subjects bs ON pa.budget_subject_id = bs.id
      LEFT JOIN suppliers s ON pa.supplier_id = s.id
      LEFT JOIN users u ON pa.applicant_id = u.id
      LEFT JOIN departments d ON pa.department_id = d.id
      LEFT JOIN approval_rules ar ON pa.rule_id = ar.id
      LEFT JOIN users au ON pa.current_auditor_id = au.id
      WHERE pa.id = ?
    `).get(id);

    app.items = JSON.parse(app.items);
    app.approval_nodes = getAllNodesWithAuditors(id);
    if (app.arrival_info) app.arrival_info = JSON.parse(app.arrival_info);

    res.json({ success: true, message: '已转交审批任务', data: app });
  } catch (err) {
    console.error('转交错误:', err);
    res.status(400).json({ success: false, message: err.message });
  }
});

router.post('/applications/:id/close', (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { comment } = req.body;

    closeApplication(id, userId, comment);

    const app = db.prepare(`
      SELECT pa.*,
             bs.name as budget_subject_name, bs.code as budget_subject_code,
             s.name as supplier_name, s.code as supplier_code,
             u.real_name as applicant_name, u.username as applicant_username,
             d.name as department_name, d.code as department_code,
             cau.real_name as current_auditor_name, cau.username as current_auditor_username
      FROM purchase_applications pa
      LEFT JOIN budget_subjects bs ON pa.budget_subject_id = bs.id
      LEFT JOIN suppliers s ON pa.supplier_id = s.id
      LEFT JOIN users u ON pa.applicant_id = u.id
      LEFT JOIN departments d ON pa.department_id = d.id
      LEFT JOIN users cau ON pa.current_auditor_id = cau.id
      WHERE pa.id = ?
    `).get(id);

    app.items = JSON.parse(app.items);
    app.approval_nodes = getAllNodesWithAuditors(id);
    if (app.arrival_info) app.arrival_info = JSON.parse(app.arrival_info);

    res.json({ success: true, message: '申请已关闭，仅支持查询，不能再修改或审批', data: app });
  } catch (err) {
    console.error('关闭错误:', err);
    res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
