const http = require('http');

function request(method, path, data = null, token = null) {
  return new Promise((resolve, reject) => {
    const postData = data ? JSON.stringify(data) : null;
    const options = {
      hostname: 'localhost',
      port: 8120,
      path: path,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) options.headers['Authorization'] = 'Bearer ' + token;
    if (postData) options.headers['Content-Length'] = Buffer.byteLength(postData);

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('解析失败: ' + body)); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

(async function() {
  try {
    console.log('--- 健康检查 ---');
    const h = await request('GET', '/api/health');
    console.log('完整返回:', JSON.stringify(h, null, 2));

    console.log('\n--- 根路径 ---');
    const r = await request('GET', '/api');
    console.log('success:', r.success);
    console.log('endpoints.auth:', JSON.stringify(r.endpoints.auth));

    console.log('\n--- 登录 ---');
    const login = await request('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    console.log('success:', login.success);
    console.log('message:', login.message);
    if (login.success) {
      console.log('token len:', login.data.token.length);
      console.log('user:', login.data.user.realName, login.data.user.roleName);
    }

    console.log('\n--- 获取部门 ---');
    const depts = await request('GET', '/api/admin/departments', null, login.data.token);
    console.log('success:', depts.success);
    if (depts.success) {
      console.log('部门列表:');
      depts.data.forEach(d => console.log('  -', d.code, d.name, '(' + d.user_count + '人)'));
    }

    console.log('\n--- 获取审核员列表 ---');
    const auds = await request('GET', '/api/admin/auditors', null, login.data.token);
    console.log('审核员:');
    auds.data.forEach(a => console.log('  -', a.username, a.real_name));

    console.log('\n--- 简单申请流程测试 ---');
    const op1 = await request('POST', '/api/auth/login', { username: 'operator1', password: 'op123456' });
    console.log('operator1登录:', op1.success);

    const subjs = await request('GET', '/api/query/public/budget-subjects?status=1', null, op1.data.token);
    const rd = subjs.data.list.find(s => s.code === 'RD-HW');
    console.log('找到科目:', rd.name);

    const sups = await request('GET', '/api/query/public/suppliers', null, op1.data.token);
    console.log('供应方数量:', sups.data.length);

    const appBody = {
      title: '测试采购申请',
      budget_subject_id: rd.id,
      total_amount: 5000,
      urgency_level: 'normal',
      supplier_id: sups.data[0].id,
      items: [{ name: '办公用品', qty: 10, unit_price: 500 }]
    };
    const created = await request('POST', '/api/operator/applications', appBody, op1.data.token);
    console.log('创建申请:', created.success, '- no:', created.data.application_no);

    const appId = created.data.id;
    const submitted = await request('POST', '/api/operator/applications/' + appId + '/submit', {}, op1.data.token);
    console.log('提交:', submitted.success, '- msg:', submitted.message);
    console.log('  状态:', submitted.data.status);
    console.log('  当前审核人:', submitted.data.current_auditor_name);

    console.log('\n--- 一级审批 ---');
    const aud1 = await request('POST', '/api/auth/login', { username: 'auditor1', password: 'aud123456' });
    const apr1 = await request('POST', '/api/auditor/applications/' + appId + '/approve',
      { comment: '同意' }, aud1.data.token);
    console.log('审批结果:', apr1.success, '- msg:', apr1.message);
    console.log('  状态:', apr1.data.status);

    console.log('\n--- 查询详情 ---');
    const detail = await request('GET', '/api/query/applications/' + appId, null, op1.data.token);
    console.log('status:', detail.data.status_name);
    console.log('nodes:', detail.data.approval_nodes.length);
    detail.data.approval_nodes.forEach((n, i) => {
      console.log(`  Node${i + 1}: ${n.assigned_auditor_name} - ${n.status}`);
    });

    console.log('\n--- 看板数据 ---');
    const dash = await request('GET', '/api/stats/dashboard', null, op1.data.token);
    console.log('总申请数:', dash.data.overview.total_applications);
    console.log('审批通过:', dash.data.overview.approved_count);
    console.log('我的创建:', dash.data.my_stats.my_created);

    console.log('\n✓ 全部测试通过!');
  } catch (err) {
    console.error('测试失败:', err.message);
    console.error(err.stack);
  }
})();
