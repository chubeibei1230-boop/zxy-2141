const express = require('express');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);

router.get('/my-pending', (req, res) => {
  try {
    const userId = req.user.id;
    const { urgency_level, date_from, date_to } = req.query;

    let sql = `
      SELECT pa.id, pa.application_no, pa.title, pa.total_amount, pa.urgency_level,
             pa.status, pa.created_at, pa.current_node_index,
             bs.name as budget_subject_name,
             u.real_name as applicant_name,
             d.name as department_name,
             ar.approval_levels
      FROM purchase_applications pa
      LEFT JOIN budget_subjects bs ON pa.budget_subject_id = bs.id
      LEFT JOIN users u ON pa.applicant_id = u.id
      LEFT JOIN departments d ON pa.department_id = d.id
      LEFT JOIN approval_rules ar ON pa.rule_id = ar.id
      WHERE pa.current_auditor_id = ? AND pa.status = 'pending_approval'
    `;
    const params = [userId];

    if (urgency_level) {
      sql += ' AND pa.urgency_level = ?';
      params.push(urgency_level);
    }
    if (date_from) {
      sql += ' AND DATE(pa.created_at) >= DATE(?)';
      params.push(date_from);
    }
    if (date_to) {
      sql += ' AND DATE(pa.created_at) <= DATE(?)';
      params.push(date_to);
    }

    sql += ' ORDER BY CASE pa.urgency_level WHEN ? THEN 1 WHEN ? THEN 2 ELSE 3 END, pa.created_at ASC';
    params.push('urgent', 'high');

    const list = db.prepare(sql).all(...params);

    const stats = {
      total: list.length,
      urgent_count: list.filter(i => i.urgency_level === 'urgent').length,
      high_count: list.filter(i => i.urgency_level === 'high').length,
      normal_count: list.filter(i => i.urgency_level === 'normal').length,
      total_amount: list.reduce((sum, i) => sum + i.total_amount, 0)
    };

    const urgencyNames = { normal: '普通', high: '高优先级', urgent: '紧急' };
    list.forEach(item => {
      item.urgency_name = urgencyNames[item.urgency_level] || item.urgency_level;
      item.current_level = (item.current_node_index || 0) + 1;
    });

    res.json({
      success: true,
      data: {
        stats,
        list
      }
    });
  } catch (err) {
    console.error('待我审批统计错误:', err);
    res.status(500).json({ success: false, message: '查询失败：' + err.message });
  }
});

router.get('/return-reasons', (req, res) => {
  try {
    const { date_from, date_to, department_id, budget_subject_id } = req.query;

    let joinSql = `
      FROM approval_nodes an
      JOIN purchase_applications pa ON an.application_id = pa.id
      LEFT JOIN users u ON an.assigned_auditor_id = u.id
      LEFT JOIN users app ON pa.applicant_id = app.id
      LEFT JOIN departments d ON pa.department_id = d.id
      LEFT JOIN budget_subjects bs ON pa.budget_subject_id = bs.id
    `;
    let whereSql = `WHERE an.status = 'returned' AND an.action = 'return'`;
    const params = [];

    if (date_from) {
      whereSql += ' AND DATE(an.operated_at) >= DATE(?)';
      params.push(date_from);
    }
    if (date_to) {
      whereSql += ' AND DATE(an.operated_at) <= DATE(?)';
      params.push(date_to);
    }
    if (department_id) {
      whereSql += ' AND pa.department_id = ?';
      params.push(department_id);
    }
    if (budget_subject_id) {
      whereSql += ' AND pa.budget_subject_id = ?';
      params.push(budget_subject_id);
    }

    const baseSql = joinSql + ' ' + whereSql;
    const totalCount = db.prepare(`SELECT COUNT(*) as count ${baseSql}`).get(...params).count;

    const listSql = `
      SELECT an.id, an.node_index, an.comment, an.operated_at,
             pa.id as application_id, pa.application_no, pa.title, pa.total_amount,
             u.real_name as returner_name,
             app.real_name as applicant_name,
             d.name as department_name,
             bs.name as budget_subject_name
      ${baseSql}
      ORDER BY an.operated_at DESC
    `;
    const list = db.prepare(listSql).all(...params);

    const reasonGroups = {};
    list.forEach(item => {
      const comment = item.comment || '未填写原因';
      let category = '其他';

      if (comment.includes('材料') || comment.includes('资料') || comment.includes('附件')) {
        category = '材料不全';
      } else if (comment.includes('预算') || comment.includes('金额') || comment.includes('费用') || comment.includes('价格')) {
        category = '预算/金额问题';
      } else if (comment.includes('报价') || comment.includes('比价') || comment.includes('供应商') || comment.includes('供应方')) {
        category = '报价/供应商问题';
      } else if (comment.includes('紧急') || comment.includes('原因') || comment.includes('说明')) {
        category = '紧急原因/说明不足';
      } else if (comment.includes('规格') || comment.includes('型号') || comment.includes('明细') || comment.includes('物品')) {
        category = '规格/明细问题';
      } else if (comment.includes('不符') || comment.includes('不符合') || comment.includes('违规') || comment.includes('政策')) {
        category = '不符合规定';
      }

      if (!reasonGroups[category]) {
        reasonGroups[category] = { category, count: 0, total_amount: 0, examples: [] };
      }
      reasonGroups[category].count++;
      reasonGroups[category].total_amount += item.total_amount;
      if (reasonGroups[category].examples.length < 3) {
        reasonGroups[category].examples.push({
          application_no: item.application_no,
          title: item.title,
          comment: comment.substring(0, 100)
        });
      }
    });

    const distribution = Object.values(reasonGroups).sort((a, b) => b.count - a.count).map(g => ({
      ...g,
      percentage: totalCount > 0 ? ((g.count / totalCount) * 100).toFixed(1) + '%' : '0%'
    }));

    const returnerStatsSql = `
      SELECT u.id as user_id, u.real_name as user_name,
             COUNT(*) as return_count,
             SUM(pa.total_amount) as total_amount
      ${joinSql}
      ${whereSql}
      GROUP BY u.id, u.real_name
      ORDER BY return_count DESC
    `;
    const byReturner = db.prepare(returnerStatsSql).all(...params);

    const nodeStatsSql = `
      SELECT an.node_index + 1 as approval_level,
             COUNT(*) as return_count,
             SUM(pa.total_amount) as total_amount
      ${baseSql}
      GROUP BY an.node_index
      ORDER BY approval_level
    `;
    const byNode = db.prepare(nodeStatsSql).all(...params);

    res.json({
      success: true,
      data: {
        summary: {
          total_count: totalCount,
          total_amount: list.reduce((s, i) => s + i.total_amount, 0),
          category_count: distribution.length
        },
        distribution,
        by_returner: byReturner,
        by_approval_level: byNode,
        detail_list: list
      }
    });
  } catch (err) {
    console.error('退回原因分布错误:', err);
    res.status(500).json({ success: false, message: '查询失败：' + err.message });
  }
});

router.get('/budget-summary', (req, res) => {
  try {
    const { date_from, date_to, status, department_id } = req.query;

    const joinSubject = `
      FROM purchase_applications pa
      JOIN budget_subjects bs ON pa.budget_subject_id = bs.id
      LEFT JOIN budget_subjects p ON bs.parent_id = p.id
    `;
    const joinDept = `
      FROM purchase_applications pa
      JOIN budget_subjects bs ON pa.budget_subject_id = bs.id
      LEFT JOIN departments d ON pa.department_id = d.id
    `;
    const baseJoin = `
      FROM purchase_applications pa
      JOIN budget_subjects bs ON pa.budget_subject_id = bs.id
    `;

    let whereSql = 'WHERE 1=1';
    const params = [];

    if (date_from) {
      whereSql += ' AND DATE(pa.created_at) >= DATE(?)';
      params.push(date_from);
    }
    if (date_to) {
      whereSql += ' AND DATE(pa.created_at) <= DATE(?)';
      params.push(date_to);
    }
    if (status) {
      if (Array.isArray(status)) {
        whereSql += ` AND pa.status IN (${status.map(() => '?').join(',')})`;
        params.push(...status);
      } else {
        whereSql += ' AND pa.status = ?';
        params.push(status);
      }
    }
    if (department_id) {
      whereSql += ' AND pa.department_id = ?';
      params.push(department_id);
    }

    const summarySql = `
      SELECT bs.id as budget_subject_id, bs.code as budget_subject_code,
             bs.name as budget_subject_name, bs.annual_budget,
             bs.parent_id,
             p.name as parent_name,
             COUNT(pa.id) as application_count,
             COUNT(DISTINCT pa.applicant_id) as applicant_count,
             SUM(CASE WHEN pa.status = 'pending_approval' THEN 1 ELSE 0 END) as pending_count,
             SUM(CASE WHEN pa.status = 'approved' OR pa.status = 'arrival_confirmed' THEN 1 ELSE 0 END) as approved_count,
             SUM(CASE WHEN pa.status = 'returned' THEN 1 ELSE 0 END) as returned_count,
             SUM(CASE WHEN pa.status = 'closed' THEN 1 ELSE 0 END) as closed_count,
             SUM(pa.total_amount) as total_amount,
             SUM(CASE WHEN pa.status = 'approved' OR pa.status = 'arrival_confirmed' THEN pa.total_amount ELSE 0 END) as approved_amount,
             SUM(CASE WHEN pa.status = 'pending_approval' THEN pa.total_amount ELSE 0 END) as pending_amount
      ${joinSubject}
      ${whereSql}
      GROUP BY bs.id, bs.code, bs.name, bs.annual_budget, bs.parent_id, p.name
      ORDER BY bs.code
    `;

    const bySubject = db.prepare(summarySql).all(...params).map(item => ({
      ...item,
      budget_usage_rate: item.annual_budget > 0
        ? ((item.approved_amount / item.annual_budget) * 100).toFixed(2) + '%'
        : '-'
    }));

    const totalStats = {
      application_count: bySubject.reduce((s, i) => s + i.application_count, 0),
      total_amount: bySubject.reduce((s, i) => s + i.total_amount, 0),
      approved_count: bySubject.reduce((s, i) => s + i.approved_count, 0),
      approved_amount: bySubject.reduce((s, i) => s + i.approved_amount, 0),
      pending_count: bySubject.reduce((s, i) => s + i.pending_count, 0),
      pending_amount: bySubject.reduce((s, i) => s + i.pending_amount, 0),
      returned_count: bySubject.reduce((s, i) => s + i.returned_count, 0),
      closed_count: bySubject.reduce((s, i) => s + i.closed_count, 0),
      total_annual_budget: bySubject.filter(i => i.parent_id === null).reduce((s, i) => s + (i.annual_budget || 0), 0)
    };

    const deptSql = `
      SELECT d.id as department_id, d.name as department_name,
             COUNT(pa.id) as application_count,
             SUM(pa.total_amount) as total_amount
      ${joinDept}
      ${whereSql}
      GROUP BY d.id, d.name
      ORDER BY application_count DESC
    `;
    const byDepartment = db.prepare(deptSql).all(...params);

    const monthSql = `
      SELECT strftime('%Y-%m', pa.created_at) as month,
             COUNT(pa.id) as application_count,
             SUM(pa.total_amount) as total_amount
      ${baseJoin}
      ${whereSql}
      GROUP BY strftime('%Y-%m', pa.created_at)
      ORDER BY month DESC
      LIMIT 12
    `;
    const byMonth = db.prepare(monthSql).all(...params).reverse();

    res.json({
      success: true,
      data: {
        total: totalStats,
        by_subject: bySubject,
        by_department: byDepartment,
        by_month: byMonth
      }
    });
  } catch (err) {
    console.error('预算科目汇总错误:', err);
    res.status(500).json({ success: false, message: '查询失败：' + err.message });
  }
});

router.get('/dashboard', (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];

    let totalApplications = db.prepare('SELECT COUNT(*) as count FROM purchase_applications').get().count;
    let thisMonthApplications = db.prepare(
      "SELECT COUNT(*) as count FROM purchase_applications WHERE DATE(created_at) >= DATE(?)"
    ).get(firstDayOfMonth).count;

    let pendingApproval = db.prepare(
      "SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as amount FROM purchase_applications WHERE status = 'pending_approval'"
    ).get();

    let approvedCount = db.prepare(
      "SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as amount FROM purchase_applications WHERE status IN ('approved', 'arrival_confirmed')"
    ).get();

    let returnedCount = db.prepare(
      "SELECT COUNT(*) as count FROM purchase_applications WHERE status = 'returned'"
    ).get();

    let closedCount = db.prepare(
      "SELECT COUNT(*) as count FROM purchase_applications WHERE status = 'closed'"
    ).get();

    let myPending = 0;
    let myCreated = 0;
    let myApproved = 0;

    if (userRole === 'auditor' || userRole === 'admin') {
      myPending = db.prepare(
        "SELECT COUNT(*) as count FROM purchase_applications WHERE current_auditor_id = ? AND status = 'pending_approval'"
      ).get(userId).count;
    }

    myCreated = db.prepare(
      "SELECT COUNT(*) as count FROM purchase_applications WHERE applicant_id = ?"
    ).get(userId).count;

    if (userRole === 'auditor') {
      myApproved = db.prepare(`
        SELECT COUNT(*) as count FROM approval_nodes
        WHERE assigned_auditor_id = ? AND status = 'approved' AND action = 'approve'
      `).get(userId).count;
    }

    const urgentPending = db.prepare(`
      SELECT pa.id, pa.application_no, pa.title, pa.total_amount, pa.created_at,
             u.real_name as applicant_name, d.name as department_name
      FROM purchase_applications pa
      LEFT JOIN users u ON pa.applicant_id = u.id
      LEFT JOIN departments d ON pa.department_id = d.id
      WHERE pa.urgency_level IN ('urgent', 'high') AND pa.status = 'pending_approval'
      ORDER BY CASE pa.urgency_level WHEN 'urgent' THEN 0 ELSE 1 END, pa.created_at ASC
      LIMIT 5
    `).all();

    const recentApplications = db.prepare(`
      SELECT pa.id, pa.application_no, pa.title, pa.total_amount, pa.status,
             pa.urgency_level, pa.created_at,
             u.real_name as applicant_name,
             bs.name as budget_subject_name
      FROM purchase_applications pa
      LEFT JOIN users u ON pa.applicant_id = u.id
      LEFT JOIN budget_subjects bs ON pa.budget_subject_id = bs.id
      ORDER BY pa.created_at DESC
      LIMIT 10
    `).all();

    const statusNames = { draft: '草稿', pending_approval: '审批中', returned: '已退回', approved: '审批通过', arrival_confirmed: '已到货', closed: '已关闭' };
    const urgencyNames = { normal: '普通', high: '高优先级', urgent: '紧急' };
    recentApplications.forEach(item => {
      item.status_name = statusNames[item.status] || item.status;
      item.urgency_name = urgencyNames[item.urgency_level] || item.urgency_level;
    });

    res.json({
      success: true,
      data: {
        overview: {
          total_applications: totalApplications,
          this_month_applications: thisMonthApplications,
          pending_approval_count: pendingApproval.count,
          pending_approval_amount: pendingApproval.amount,
          approved_count: approvedCount.count,
          approved_amount: approvedCount.amount,
          returned_count: returnedCount.count,
          closed_count: closedCount.count
        },
        my_stats: {
          my_pending: myPending,
          my_created: myCreated,
          my_approved: myApproved
        },
        urgent_pending: urgentPending,
        recent_applications: recentApplications
      }
    });
  } catch (err) {
    console.error('看板统计错误:', err);
    res.status(500).json({ success: false, message: '查询失败：' + err.message });
  }
});

module.exports = router;
