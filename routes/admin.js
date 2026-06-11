const express = require('express');
const { db } = require('../database');
const { authMiddleware, roleMiddleware } = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware, roleMiddleware('admin'));

router.get('/departments', (req, res) => {
  try {
    const departments = db.prepare(`
      SELECT d.*,
             (SELECT COUNT(*) FROM users WHERE department_id = d.id) as user_count
      FROM departments d
      ORDER BY d.code
    `).all();
    res.json({ success: true, data: departments });
  } catch (err) {
    res.status(500).json({ success: false, message: '查询部门失败：' + err.message });
  }
});

router.post('/departments', (req, res) => {
  try {
    const { name, code, description } = req.body;
    if (!name || !code) {
      return res.status(400).json({ success: false, message: '部门名称和编码不能为空' });
    }

    const exists = db.prepare('SELECT id FROM departments WHERE name = ? OR code = ?').get(name, code);
    if (exists) {
      return res.status(400).json({ success: false, message: '部门名称或编码已存在' });
    }

    const info = db.prepare(
      'INSERT INTO departments (name, code, description) VALUES (?, ?, ?)'
    ).run(name, code, description);

    const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(info.lastInsertRowid);
    res.json({ success: true, message: '创建部门成功', data: dept });
  } catch (err) {
    res.status(500).json({ success: false, message: '创建部门失败：' + err.message });
  }
});

router.put('/departments/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, description } = req.body;

    const exists = db.prepare('SELECT id FROM departments WHERE id = ?').get(id);
    if (!exists) {
      return res.status(404).json({ success: false, message: '部门不存在' });
    }

    const duplicate = db.prepare(
      'SELECT id FROM departments WHERE (name = ? OR code = ?) AND id != ?'
    ).get(name, code, id);
    if (duplicate) {
      return res.status(400).json({ success: false, message: '部门名称或编码已被其他部门使用' });
    }

    db.prepare(
      'UPDATE departments SET name = ?, code = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(name, code, description, id);

    const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
    res.json({ success: true, message: '更新部门成功', data: dept });
  } catch (err) {
    res.status(500).json({ success: false, message: '更新部门失败：' + err.message });
  }
});

router.delete('/departments/:id', (req, res) => {
  try {
    const { id } = req.params;

    const userCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE department_id = ?').get(id).count;
    if (userCount > 0) {
      return res.status(400).json({ success: false, message: `该部门下有${userCount}名用户，无法删除` });
    }

    const result = db.prepare('DELETE FROM departments WHERE id = ?').run(id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: '部门不存在' });
    }
    res.json({ success: true, message: '删除部门成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: '删除部门失败：' + err.message });
  }
});

router.get('/budget-subjects', (req, res) => {
  try {
    const subjects = db.prepare(`
      SELECT bs.*,
             p.name as parent_name,
             (SELECT COUNT(*) FROM budget_subjects WHERE parent_id = bs.id) as child_count
      FROM budget_subjects bs
      LEFT JOIN budget_subjects p ON bs.parent_id = p.id
      ORDER BY bs.code
    `).all();

    const buildTree = (items, parentId = null) => {
      return items
        .filter(item => (item.parent_id === null && parentId === null) || item.parent_id === parentId)
        .map(item => ({
          ...item,
          children: buildTree(items, item.id)
        }));
    };

    res.json({ success: true, data: { list: subjects, tree: buildTree(subjects) } });
  } catch (err) {
    res.status(500).json({ success: false, message: '查询预算科目失败：' + err.message });
  }
});

router.post('/budget-subjects', (req, res) => {
  try {
    const { name, code, parent_id, description, annual_budget, status } = req.body;
    if (!name || !code) {
      return res.status(400).json({ success: false, message: '科目名称和编码不能为空' });
    }

    if (parent_id) {
      const parent = db.prepare('SELECT id FROM budget_subjects WHERE id = ?').get(parent_id);
      if (!parent) {
        return res.status(400).json({ success: false, message: '上级科目不存在' });
      }
    }

    const exists = db.prepare('SELECT id FROM budget_subjects WHERE name = ? OR code = ?').get(name, code);
    if (exists) {
      return res.status(400).json({ success: false, message: '科目名称或编码已存在' });
    }

    const info = db.prepare(
      'INSERT INTO budget_subjects (name, code, parent_id, description, annual_budget, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name, code, parent_id || null, description, annual_budget || 0, status ?? 1);

    const subject = db.prepare('SELECT * FROM budget_subjects WHERE id = ?').get(info.lastInsertRowid);
    res.json({ success: true, message: '创建预算科目成功', data: subject });
  } catch (err) {
    res.status(500).json({ success: false, message: '创建预算科目失败：' + err.message });
  }
});

router.put('/budget-subjects/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, parent_id, description, annual_budget, status } = req.body;

    const exists = db.prepare('SELECT id FROM budget_subjects WHERE id = ?').get(id);
    if (!exists) {
      return res.status(404).json({ success: false, message: '预算科目不存在' });
    }

    if (parent_id && parseInt(parent_id) === parseInt(id)) {
      return res.status(400).json({ success: false, message: '上级科目不能是自身' });
    }

    const duplicate = db.prepare(
      'SELECT id FROM budget_subjects WHERE (name = ? OR code = ?) AND id != ?'
    ).get(name, code, id);
    if (duplicate) {
      return res.status(400).json({ success: false, message: '科目名称或编码已被其他科目使用' });
    }

    db.prepare(
      'UPDATE budget_subjects SET name = ?, code = ?, parent_id = ?, description = ?, annual_budget = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(name, code, parent_id || null, description, annual_budget || 0, status ?? 1, id);

    const subject = db.prepare('SELECT * FROM budget_subjects WHERE id = ?').get(id);
    res.json({ success: true, message: '更新预算科目成功', data: subject });
  } catch (err) {
    res.status(500).json({ success: false, message: '更新预算科目失败：' + err.message });
  }
});

router.delete('/budget-subjects/:id', (req, res) => {
  try {
    const { id } = req.params;

    const childCount = db.prepare('SELECT COUNT(*) as count FROM budget_subjects WHERE parent_id = ?').get(id).count;
    if (childCount > 0) {
      return res.status(400).json({ success: false, message: `该科目下有${childCount}个子科目，无法删除` });
    }

    const appCount = db.prepare('SELECT COUNT(*) as count FROM purchase_applications WHERE budget_subject_id = ?').get(id).count;
    if (appCount > 0) {
      return res.status(400).json({ success: false, message: `该科目关联了${appCount}条采购申请，无法删除` });
    }

    const result = db.prepare('DELETE FROM budget_subjects WHERE id = ?').run(id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: '预算科目不存在' });
    }
    res.json({ success: true, message: '删除预算科目成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: '删除预算科目失败：' + err.message });
  }
});

router.get('/suppliers', (req, res) => {
  try {
    const { status, keyword } = req.query;
    let sql = 'SELECT * FROM suppliers WHERE 1=1';
    const params = [];

    if (status !== undefined) {
      sql += ' AND status = ?';
      params.push(parseInt(status));
    }
    if (keyword) {
      sql += ' AND (name LIKE ? OR code LIKE ? OR contact_person LIKE ?)';
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw);
    }
    sql += ' ORDER BY code';

    const suppliers = db.prepare(sql).all(...params);
    res.json({ success: true, data: suppliers });
  } catch (err) {
    res.status(500).json({ success: false, message: '查询供应方失败：' + err.message });
  }
});

router.get('/suppliers/:id', (req, res) => {
  try {
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
    if (!supplier) {
      return res.status(404).json({ success: false, message: '供应方不存在' });
    }
    res.json({ success: true, data: supplier });
  } catch (err) {
    res.status(500).json({ success: false, message: '查询供应方失败：' + err.message });
  }
});

router.post('/suppliers', (req, res) => {
  try {
    const { name, code, contact_person, contact_phone, address, bank_name, bank_account, tax_number, description, status } = req.body;
    if (!name || !code) {
      return res.status(400).json({ success: false, message: '供应方名称和编码不能为空' });
    }

    const exists = db.prepare('SELECT id FROM suppliers WHERE code = ?').get(code);
    if (exists) {
      return res.status(400).json({ success: false, message: '供应方编码已存在' });
    }

    const info = db.prepare(
      'INSERT INTO suppliers (name, code, contact_person, contact_phone, address, bank_name, bank_account, tax_number, description, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(name, code, contact_person, contact_phone, address, bank_name, bank_account, tax_number, description, status ?? 1);

    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(info.lastInsertRowid);
    res.json({ success: true, message: '创建供应方成功', data: supplier });
  } catch (err) {
    res.status(500).json({ success: false, message: '创建供应方失败：' + err.message });
  }
});

router.put('/suppliers/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, contact_person, contact_phone, address, bank_name, bank_account, tax_number, description, status } = req.body;

    const exists = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(id);
    if (!exists) {
      return res.status(404).json({ success: false, message: '供应方不存在' });
    }

    const duplicate = db.prepare('SELECT id FROM suppliers WHERE code = ? AND id != ?').get(code, id);
    if (duplicate) {
      return res.status(400).json({ success: false, message: '供应方编码已被其他供应方使用' });
    }

    db.prepare(
      'UPDATE suppliers SET name = ?, code = ?, contact_person = ?, contact_phone = ?, address = ?, bank_name = ?, bank_account = ?, tax_number = ?, description = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(name, code, contact_person, contact_phone, address, bank_name, bank_account, tax_number, description, status ?? 1, id);

    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    res.json({ success: true, message: '更新供应方成功', data: supplier });
  } catch (err) {
    res.status(500).json({ success: false, message: '更新供应方失败：' + err.message });
  }
});

router.delete('/suppliers/:id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM suppliers WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: '供应方不存在' });
    }
    res.json({ success: true, message: '删除供应方成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: '删除供应方失败：' + err.message });
  }
});

router.get('/approval-rules', (req, res) => {
  try {
    const auditors = db.prepare('SELECT id, username, real_name FROM users WHERE role = ?').all('auditor');
    const auditorMap = {};
    auditors.forEach(a => auditorMap[a.id] = a);

    const rules = db.prepare(`
      SELECT ar.*, bs.name as budget_subject_name
      FROM approval_rules ar
      LEFT JOIN budget_subjects bs ON ar.budget_subject_id = bs.id
      ORDER BY ar.id
    `).all();

    const data = rules.map(r => ({
      ...r,
      auditor_list: JSON.parse(r.auditor_ids).map(id => auditorMap[id]).filter(Boolean)
    }));

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: '查询审批规则失败：' + err.message });
  }
});

router.post('/approval-rules', (req, res) => {
  try {
    const { name, budget_subject_id, min_amount, max_amount, urgency_level, approval_levels, auditor_ids, description, status } = req.body;

    if (!name || !approval_levels || !auditor_ids || !Array.isArray(auditor_ids) || auditor_ids.length === 0) {
      return res.status(400).json({ success: false, message: '规则名称、审批级别、审核员列表不能为空' });
    }

    if (approval_levels !== auditor_ids.length) {
      return res.status(400).json({ success: false, message: '审核员数量必须与审批级别一致' });
    }

    const invalidAuditors = auditor_ids.filter(id => {
      const u = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
      return !u || u.role !== 'auditor';
    });
    if (invalidAuditors.length > 0) {
      return res.status(400).json({ success: false, message: `存在无效的审核员ID：${invalidAuditors.join(', ')}` });
    }

    const info = db.prepare(
      `INSERT INTO approval_rules (name, budget_subject_id, min_amount, max_amount, urgency_level, approval_levels, auditor_ids, description, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      name,
      budget_subject_id || null,
      min_amount || 0,
      max_amount || 9999999999999.99,
      urgency_level || 'all',
      approval_levels,
      JSON.stringify(auditor_ids),
      description,
      status ?? 1
    );

    const rule = db.prepare('SELECT * FROM approval_rules WHERE id = ?').get(info.lastInsertRowid);
    res.json({ success: true, message: '创建审批规则成功', data: rule });
  } catch (err) {
    res.status(500).json({ success: false, message: '创建审批规则失败：' + err.message });
  }
});

router.put('/approval-rules/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, budget_subject_id, min_amount, max_amount, urgency_level, approval_levels, auditor_ids, description, status } = req.body;

    const exists = db.prepare('SELECT id FROM approval_rules WHERE id = ?').get(id);
    if (!exists) {
      return res.status(404).json({ success: false, message: '审批规则不存在' });
    }

    if (!approval_levels || !auditor_ids || !Array.isArray(auditor_ids) || auditor_ids.length === 0) {
      return res.status(400).json({ success: false, message: '审批级别、审核员列表不能为空' });
    }

    if (approval_levels !== auditor_ids.length) {
      return res.status(400).json({ success: false, message: '审核员数量必须与审批级别一致' });
    }

    db.prepare(
      `UPDATE approval_rules SET name = ?, budget_subject_id = ?, min_amount = ?, max_amount = ?, urgency_level = ?,
       approval_levels = ?, auditor_ids = ?, description = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(
      name,
      budget_subject_id || null,
      min_amount || 0,
      max_amount || 9999999999999.99,
      urgency_level || 'all',
      approval_levels,
      JSON.stringify(auditor_ids),
      description,
      status ?? 1,
      id
    );

    const rule = db.prepare('SELECT * FROM approval_rules WHERE id = ?').get(id);
    res.json({ success: true, message: '更新审批规则成功', data: rule });
  } catch (err) {
    res.status(500).json({ success: false, message: '更新审批规则失败：' + err.message });
  }
});

router.delete('/approval-rules/:id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM approval_rules WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: '审批规则不存在' });
    }
    res.json({ success: true, message: '删除审批规则成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: '删除审批规则失败：' + err.message });
  }
});

router.get('/users', (req, res) => {
  try {
    const { role, department_id } = req.query;
    let sql = `
      SELECT u.id, u.username, u.real_name, u.role, u.email, u.phone,
             d.name as department_name, d.code as department_code,
             u.created_at
      FROM users u
      LEFT JOIN departments d ON u.department_id = d.id
      WHERE 1=1
    `;
    const params = [];
    if (role) {
      sql += ' AND u.role = ?';
      params.push(role);
    }
    if (department_id) {
      sql += ' AND u.department_id = ?';
      params.push(department_id);
    }
    sql += ' ORDER BY u.id';
    const users = db.prepare(sql).all(...params);

    const roleNames = { admin: '管理员', operator: '操作员', auditor: '审核员' };
    const data = users.map(u => ({ ...u, role_name: roleNames[u.role] }));

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: '查询用户失败：' + err.message });
  }
});

router.get('/auditors', (req, res) => {
  try {
    const auditors = db.prepare(`
      SELECT u.id, u.username, u.real_name, u.role, u.email, u.phone,
             d.name as department_name
      FROM users u
      LEFT JOIN departments d ON u.department_id = d.id
      WHERE u.role = 'auditor'
      ORDER BY u.id
    `).all();
    res.json({ success: true, data: auditors });
  } catch (err) {
    res.status(500).json({ success: false, message: '查询审核员失败：' + err.message });
  }
});

module.exports = router;
