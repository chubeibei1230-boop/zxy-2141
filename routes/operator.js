const express = require('express');
const { db } = require('../database');
const { authMiddleware, roleMiddleware } = require('../middleware/auth');
const {
  generateApplicationNo,
  submitApplication,
  resubmitApplication,
  updateQuoteDescription,
  confirmArrival,
  logOperation,
  getAllNodesWithAuditors
} = require('../services/approvalEngine');

const router = express.Router();

router.use(authMiddleware, roleMiddleware('operator', 'admin'));

router.post('/applications', (req, res) => {
  try {
    const userId = req.user.id;
    const user = db.prepare('SELECT department_id FROM users WHERE id = ?').get(userId);

    const {
      title, budget_subject_id, total_amount, urgency_level = 'normal',
      urgent_reason, supplier_id, expected_date, items, quote_description
    } = req.body;

    if (!title || !budget_subject_id || !total_amount || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: '标题、预算科目、总金额、采购明细不能为空'
      });
    }

    if (parseFloat(total_amount) <= 0) {
      return res.status(400).json({ success: false, message: '总金额必须大于0' });
    }

    if (!['normal', 'high', 'urgent'].includes(urgency_level)) {
      return res.status(400).json({ success: false, message: '紧急程度只能是 normal、high 或 urgent' });
    }

    if (urgency_level === 'urgent' && (!urgent_reason || urgent_reason.trim() === '')) {
      return res.status(400).json({ success: false, message: '紧急申请必须填写紧急原因' });
    }

    const subject = db.prepare('SELECT id, status FROM budget_subjects WHERE id = ?').get(budget_subject_id);
    if (!subject) {
      return res.status(400).json({ success: false, message: '预算科目不存在' });
    }
    if (subject.status !== 1) {
      return res.status(400).json({ success: false, message: '预算科目已禁用' });
    }

    const applicationNo = generateApplicationNo();
    const deptId = user.department_id || (req.body.department_id ? req.body.department_id : null);

    const info = db.prepare(`
      INSERT INTO purchase_applications
      (application_no, title, applicant_id, department_id, budget_subject_id, total_amount,
       urgency_level, urgent_reason, supplier_id, expected_date, items, quote_description,
       status, current_node_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0)
    `).run(
      applicationNo, title, userId, deptId, budget_subject_id, parseFloat(total_amount),
      urgency_level, urgent_reason || null, supplier_id || null, expected_date || null,
      JSON.stringify(items), quote_description || null
    );

    const appId = info.lastInsertRowid;
    logOperation(appId, userId, '创建申请', 'create', null, 'draft', '创建采购申请草稿');

    const app = db.prepare(`
      SELECT pa.*,
             bs.name as budget_subject_name, bs.code as budget_subject_code,
             s.name as supplier_name, s.code as supplier_code,
             u.real_name as applicant_name, u.username as applicant_username,
             d.name as department_name, d.code as department_code
      FROM purchase_applications pa
      LEFT JOIN budget_subjects bs ON pa.budget_subject_id = bs.id
      LEFT JOIN suppliers s ON pa.supplier_id = s.id
      LEFT JOIN users u ON pa.applicant_id = u.id
      LEFT JOIN departments d ON pa.department_id = d.id
      WHERE pa.id = ?
    `).get(appId);

    app.items = JSON.parse(app.items);
    if (app.arrival_info) app.arrival_info = JSON.parse(app.arrival_info);

    res.json({ success: true, message: '创建采购申请成功', data: app });
  } catch (err) {
    console.error('创建申请错误:', err);
    res.status(500).json({ success: false, message: '创建采购申请失败：' + err.message });
  }
});

router.put('/applications/:id', (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(id);
    if (!app) {
      return res.status(404).json({ success: false, message: '采购申请不存在' });
    }

    if (app.applicant_id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '只有申请人本人或管理员可以修改申请' });
    }

    if (app.status === 'closed') {
      return res.status(400).json({ success: false, message: '申请已关闭，无法修改' });
    }

    if (app.status === 'pending_approval') {
      return res.status(400).json({ success: false, message: '申请正在审批中，无法修改，请先联系审核人退回' });
    }

    if (app.status === 'approved' || app.status === 'arrival_confirmed') {
      return res.status(400).json({ success: false, message: '申请已审批通过，无法修改' });
    }

    const {
      title, budget_subject_id, total_amount, urgency_level,
      urgent_reason, supplier_id, expected_date, items, quote_description
    } = req.body;

    const finalUrgency = urgency_level !== undefined ? urgency_level : app.urgency_level;
    if (finalUrgency === 'urgent') {
      const finalReason = urgent_reason !== undefined ? urgent_reason : app.urgent_reason;
      if (!finalReason || finalReason.trim() === '') {
        return res.status(400).json({ success: false, message: '紧急申请必须填写紧急原因' });
      }
    }

    const updates = [];
    const values = [];

    if (title !== undefined) { updates.push('title = ?'); values.push(title); }
    if (budget_subject_id !== undefined) { updates.push('budget_subject_id = ?'); values.push(budget_subject_id); }
    if (total_amount !== undefined) { updates.push('total_amount = ?'); values.push(parseFloat(total_amount)); }
    if (urgency_level !== undefined) { updates.push('urgency_level = ?'); values.push(urgency_level); }
    if (urgent_reason !== undefined) { updates.push('urgent_reason = ?'); values.push(urgent_reason); }
    if (supplier_id !== undefined) { updates.push('supplier_id = ?'); values.push(supplier_id); }
    if (expected_date !== undefined) { updates.push('expected_date = ?'); values.push(expected_date); }
    if (items !== undefined) {
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: '采购明细不能为空' });
      }
      updates.push('items = ?');
      values.push(JSON.stringify(items));
    }
    if (quote_description !== undefined) { updates.push('quote_description = ?'); values.push(quote_description); }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: '没有需要更新的字段' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    db.prepare(`UPDATE purchase_applications SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    logOperation(id, userId, '修改申请', 'update', app.status, app.status, '修改了采购申请内容');

    const updated = db.prepare(`
      SELECT pa.*,
             bs.name as budget_subject_name, bs.code as budget_subject_code,
             s.name as supplier_name, s.code as supplier_code,
             u.real_name as applicant_name, u.username as applicant_username,
             d.name as department_name, d.code as department_code
      FROM purchase_applications pa
      LEFT JOIN budget_subjects bs ON pa.budget_subject_id = bs.id
      LEFT JOIN suppliers s ON pa.supplier_id = s.id
      LEFT JOIN users u ON pa.applicant_id = u.id
      LEFT JOIN departments d ON pa.department_id = d.id
      WHERE pa.id = ?
    `).get(id);

    updated.items = JSON.parse(updated.items);
    if (updated.arrival_info) updated.arrival_info = JSON.parse(updated.arrival_info);

    res.json({ success: true, message: '更新采购申请成功', data: updated });
  } catch (err) {
    console.error('更新申请错误:', err);
    res.status(500).json({ success: false, message: '更新采购申请失败：' + err.message });
  }
});

router.delete('/applications/:id', (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(id);
    if (!app) {
      return res.status(404).json({ success: false, message: '采购申请不存在' });
    }

    if (app.applicant_id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '只有申请人本人或管理员可以删除申请' });
    }

    if (app.status !== 'draft' && app.status !== 'returned') {
      return res.status(400).json({ success: false, message: '只有草稿或退回状态的申请可以删除' });
    }

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM approval_nodes WHERE application_id = ?').run(id);
      db.prepare('DELETE FROM operation_logs WHERE application_id = ?').run(id);
      db.prepare('DELETE FROM purchase_applications WHERE id = ?').run(id);
    });
    tx();

    res.json({ success: true, message: '删除采购申请成功' });
  } catch (err) {
    console.error('删除申请错误:', err);
    res.status(500).json({ success: false, message: '删除采购申请失败：' + err.message });
  }
});

router.post('/applications/:id/submit', (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const app = db.prepare('SELECT * FROM purchase_applications WHERE id = ?').get(id);
    if (!app) {
      return res.status(404).json({ success: false, message: '采购申请不存在' });
    }

    if (app.applicant_id !== userId) {
      return res.status(403).json({ success: false, message: '只有申请人本人可以提交申请' });
    }

    let result;
    if (app.status === 'draft') {
      result = submitApplication(id, userId);
    } else if (app.status === 'returned') {
      result = resubmitApplication(id, userId);
    } else {
      return res.status(400).json({ success: false, message: '当前状态不允许提交' });
    }

    const updated = db.prepare(`
      SELECT pa.*,
             bs.name as budget_subject_name, bs.code as budget_subject_code,
             s.name as supplier_name, s.code as supplier_code,
             u.real_name as applicant_name, u.username as applicant_username,
             d.name as department_name, d.code as department_code,
             ar.name as rule_name, ar.approval_levels,
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

    updated.items = JSON.parse(updated.items);
    updated.approval_nodes = getAllNodesWithAuditors(id);
    if (updated.arrival_info) updated.arrival_info = JSON.parse(updated.arrival_info);

    res.json({
      success: true,
      message: app.status === 'draft' ? '提交成功，已进入审批流程' : '重新提交成功，已进入审批流程',
      data: updated
    });
  } catch (err) {
    console.error('提交申请错误:', err);
    res.status(400).json({ success: false, message: err.message });
  }
});

router.put('/applications/:id/quote', (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { quote_description } = req.body;

    if (!quote_description || quote_description.trim() === '') {
      return res.status(400).json({ success: false, message: '报价说明不能为空' });
    }

    updateQuoteDescription(id, userId, quote_description);

    const app = db.prepare(`
      SELECT pa.*,
             bs.name as budget_subject_name,
             u.real_name as applicant_name,
             d.name as department_name
      FROM purchase_applications pa
      LEFT JOIN budget_subjects bs ON pa.budget_subject_id = bs.id
      LEFT JOIN users u ON pa.applicant_id = u.id
      LEFT JOIN departments d ON pa.department_id = d.id
      WHERE pa.id = ?
    `).get(id);

    app.items = JSON.parse(app.items);
    res.json({ success: true, message: '报价说明更新成功', data: app });
  } catch (err) {
    console.error('更新报价错误:', err);
    res.status(400).json({ success: false, message: err.message });
  }
});

router.post('/applications/:id/arrival', (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { arrival_info, comment } = req.body;

    if (!arrival_info) {
      return res.status(400).json({ success: false, message: '到货信息不能为空' });
    }

    confirmArrival(id, userId, arrival_info, comment);

    const app = db.prepare(`
      SELECT pa.*,
             bs.name as budget_subject_name,
             u.real_name as applicant_name,
             d.name as department_name
      FROM purchase_applications pa
      LEFT JOIN budget_subjects bs ON pa.budget_subject_id = bs.id
      LEFT JOIN users u ON pa.applicant_id = u.id
      LEFT JOIN departments d ON pa.department_id = d.id
      WHERE pa.id = ?
    `).get(id);

    app.items = JSON.parse(app.items);
    app.arrival_info = JSON.parse(app.arrival_info);
    app.approval_nodes = getAllNodesWithAuditors(id);

    res.json({ success: true, message: '到货确认成功', data: app });
  } catch (err) {
    console.error('到货确认错误:', err);
    res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
