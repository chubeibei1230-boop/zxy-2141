const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDatabase } = require('./database');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const operatorRoutes = require('./routes/operator');
const auditorRoutes = require('./routes/auditor');
const { router: queryRoutes } = require('./routes/query');
const statsRoutes = require('./routes/stats');

const PORT = 8120;

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

initDatabase();

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/operator', operatorRoutes);
app.use('/api/auditor', auditorRoutes);
app.use('/api/query', queryRoutes);
app.use('/api/stats', statsRoutes);

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: '采购管理系统API运行正常',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

app.get('/api', (req, res) => {
  res.json({
    success: true,
    message: '欢迎使用采购管理系统API',
    endpoints: {
      auth: {
        login: 'POST /api/auth/login',
        me: 'GET /api/auth/me'
      },
      admin: {
        departments: 'GET/POST/PUT/DELETE /api/admin/departments',
        budget_subjects: 'GET/POST/PUT/DELETE /api/admin/budget-subjects',
        suppliers: 'GET/POST/PUT/DELETE /api/admin/suppliers',
        approval_rules: 'GET/POST/PUT/DELETE /api/admin/approval-rules',
        users: 'GET /api/admin/users',
        auditors: 'GET /api/admin/auditors'
      },
      operator: {
        create_application: 'POST /api/operator/applications',
        update_application: 'PUT /api/operator/applications/:id',
        delete_application: 'DELETE /api/operator/applications/:id',
        submit_application: 'POST /api/operator/applications/:id/submit',
        update_quote: 'PUT /api/operator/applications/:id/quote',
        confirm_arrival: 'POST /api/operator/applications/:id/arrival',
        list_materials: 'GET /api/operator/applications/:id/materials',
        add_material: 'POST /api/operator/applications/:id/materials',
        update_material: 'PUT /api/operator/materials/:materialId',
        delete_material: 'DELETE /api/operator/materials/:materialId',
        material_changes: 'GET /api/operator/materials/:materialId/changes',
        return_requirements: 'GET /api/operator/applications/:id/return-requirements',
        material_types: 'GET /api/operator/material-types',
        material_statuses: 'GET /api/operator/material-statuses'
      },
      auditor: {
        approve: 'POST /api/auditor/applications/:id/approve',
        return: 'POST /api/auditor/applications/:id/return (支持material_requirements参数)',
        transfer: 'POST /api/auditor/applications/:id/transfer',
        close: 'POST /api/auditor/applications/:id/close',
        list_materials: 'GET /api/auditor/applications/:id/materials',
        material_changes: 'GET /api/auditor/materials/:materialId/changes',
        all_material_changes: 'GET /api/auditor/applications/:id/material-change-logs',
        return_requirements: 'GET /api/auditor/applications/:id/return-requirements',
        material_types: 'GET /api/auditor/material-types',
        material_statuses: 'GET /api/auditor/material-statuses',
        requirement_types: 'GET /api/auditor/requirement-types'
      },
      query: {
        list: 'GET /api/query/applications',
        detail: 'GET /api/query/applications/:id (含材料清单、变更记录、退回要求)',
        logs: 'GET /api/query/applications/:id/logs',
        nodes: 'GET /api/query/applications/:id/nodes',
        materials: 'GET /api/query/applications/:id/materials',
        material_change_logs: 'GET /api/query/applications/:id/material-change-logs',
        material_changes: 'GET /api/query/materials/:materialId/changes',
        return_requirements: 'GET /api/query/applications/:id/return-requirements',
        public_budget_subjects: 'GET /api/query/public/budget-subjects',
        public_suppliers: 'GET /api/query/public/suppliers',
        public_departments: 'GET /api/query/public/departments',
        match_rule: 'GET /api/query/public/approval-rules/match',
        public_material_types: 'GET /api/query/public/material-types',
        public_material_statuses: 'GET /api/query/public/material-statuses',
        public_requirement_types: 'GET /api/query/public/requirement-types'
      },
      stats: {
        my_pending: 'GET /api/stats/my-pending',
        return_reasons: 'GET /api/stats/return-reasons',
        budget_summary: 'GET /api/stats/budget-summary',
        dashboard: 'GET /api/stats/dashboard'
      }
    },
    test_accounts: {
      admin: { username: 'admin', password: 'admin123', role: '管理员' },
      operators: [
        { username: 'operator1', password: 'op123456', role: '操作员', name: '张三' },
        { username: 'operator2', password: 'op123456', role: '操作员', name: '李四' }
      ],
      auditors: [
        { username: 'auditor1', password: 'aud123456', role: '审核员', name: '王审核' },
        { username: 'auditor2', password: 'aud123456', role: '审核员', name: '赵审核' },
        { username: 'auditor3', password: 'aud123456', role: '审核员', name: '钱总监' }
      ]
    }
  });
});

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || '服务器内部错误',
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `接口不存在: ${req.method} ${req.originalUrl}`,
    hint: '请查看 /api 获取所有可用接口列表'
  });
});

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('   采购管理系统 API 服务已启动');
  console.log('='.repeat(60));
  console.log(`   服务地址:  http://localhost:${PORT}`);
  console.log(`   API根路径:  http://localhost:${PORT}/api`);
  console.log(`   健康检查:   http://localhost:${PORT}/api/health`);
  console.log('='.repeat(60));
  console.log('   测试账号:');
  console.log('   ┌────────────┬────────────┬────────┬───────────┐');
  console.log('   │  用户名    │  密码      │  角色  │  姓名     │');
  console.log('   ├────────────┼────────────┼────────┼───────────┤');
  console.log('   │ admin      │ admin123   │ 管理员 │ 系统管理员 │');
  console.log('   │ operator1  │ op123456   │ 操作员 │ 张三      │');
  console.log('   │ operator2  │ op123456   │ 操作员 │ 李四      │');
  console.log('   │ auditor1   │ aud123456  │ 审核员 │ 王审核    │');
  console.log('   │ auditor2   │ aud123456  │ 审核员 │ 赵审核    │');
  console.log('   │ auditor3   │ aud123456  │ 审核员 │ 钱总监    │');
  console.log('   └────────────┴────────────┴────────┴───────────┘');
  console.log('='.repeat(60));
});

module.exports = app;
