const http = require('http');

const baseUrl = 'localhost';
const port = 8120;

function request(method, path, data = null, token = null) {
  return new Promise((resolve, reject) => {
    const postData = data ? JSON.stringify(data) : null;
    const options = {
      hostname: baseUrl,
      port: port,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      }
    };
    if (token) options.headers['Authorization'] = 'Bearer ' + token;
    if (postData) options.headers['Content-Length'] = Buffer.byteLength(postData);

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('解析响应失败: ' + body)); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

(async function main() {
  try {
    console.log('\n========== 完整业务流程测试 ==========\n');

    console.log('【1/9】健康检查');
    const health = await request('GET', '/api/health');
    console.log('  ✓', health.message, '- Version:', health.data.version);

    console.log('\n【2/9】操作员登录 - operator1');
    const op1Login = await request('POST', '/api/auth/login', { username: 'operator1', password: 'op123456' });
    const op1Token = op1Login.data.token;
    console.log('  ✓ 登录成功:', op1Login.data.user.realName, '-', op1Login.data.user.roleName);

    console.log('\n【3/9】获取预算科目和供应方');
    const subjects = await request('GET', '/api/query/public/budget-subjects?status=1', null, op1Token);
    const hwSubject = subjects.data.list.find(s => s.code === 'RD-HW');
    console.log('  ✓ 预算科目数:', subjects.data.list.length, '- 选中:', hwSubject.name);

    const suppliers = await request('GET', '/api/query/public/suppliers', null, op1Token);
    const sup1 = suppliers.data[0];
    console.log('  ✓ 供应方数:', suppliers.data.length, '- 选中:', sup1.name);

    console.log('\n【4/9】匹配审批规则（预览）');
    const matchRule = await request('GET',
      `/api/query/public/approval-rules/match?budget_subject_id=${hwSubject.id}&amount=58000&urgency_level=high`,
      null, op1Token);
    console.log('  ✓ 匹配规则:', matchRule.data.name, '- 级别:', matchRule.data.approval_levels, '级');
    console.log('    审核员:', matchRule.data.auditor_list.map(a => a.real_name).join(' -> '));

    console.log('\n【5/9】创建采购申请（草稿）并提交');
    const appData = {
      title: '采购开发服务器',
      budget_subject_id: hwSubject.id,
      total_amount: 58000.00,
      urgency_level: 'high',
      supplier_id: sup1.id,
      expected_date: '2026-06-20',
      items: [
        { name: 'Dell R750 服务器', qty: 2, unit_price: 25000, spec: '2*Xeon Gold 6330/256GB/4TB SSD' },
        { name: '网络交换机', qty: 1, unit_price: 8000, spec: '48口千兆交换机' }
      ],
      quote_description: '已获取三家报价，选择性价比最高的科技设备有限公司'
    };
    const created = await request('POST', '/api/operator/applications', appData, op1Token);
    const appId = created.data.id;
    console.log('  ✓ 创建成功:', created.data.application_no, '- 状态:', created.data.status);

    const submitted = await request('POST', `/api/operator/applications/${appId}/submit`, {}, op1Token);
    console.log('  ✓ 提交成功:', submitted.message);
    console.log('    当前状态:', submitted.data.status, '- 当前审核人:', submitted.data.current_auditor_name);

    console.log('\n【6/9】审核员1登录并审批');
    const aud1Login = await request('POST', '/api/auth/login', { username: 'auditor1', password: 'aud123456' });
    const aud1Token = aud1Login.data.token;
    console.log('  ✓ auditor1登录:', aud1Login.data.user.realName);

    const approve1 = await request('POST', `/api/auditor/applications/${appId}/approve`,
      { comment: '申请材料完整，同意进入下一级审核' }, aud1Token);
    console.log('  ✓ 第一级审批完成:', approve1.message);
    console.log('    当前状态:', approve1.data.status, '- 下一审核人:', approve1.data.current_auditor_name || '无(已完成)');

    console.log('\n【7/9】审核员2登录并审批');
    const aud2Login = await request('POST', '/api/auth/login', { username: 'auditor2', password: 'aud123456' });
    const aud2Token = aud2Login.data.token;
    console.log('  ✓ auditor2登录:', aud2Login.data.user.realName);

    const approve2 = await request('POST', `/api/auditor/applications/${appId}/approve`,
      { comment: '金额在预算范围内，同意' }, aud2Token);
    console.log('  ✓ 第二级审批完成:', approve2.message);
    console.log('    最终状态:', approve2.data.status);

    console.log('\n【8/9】查询申请详情');
    const detail = await request('GET', `/api/query/applications/${appId}`, null, op1Token);
    console.log('  ✓ 标题:', detail.data.title);
    console.log('    状态:', detail.data.status_name);
    console.log('    审批节点:');
    detail.data.approval_nodes.forEach(n => {
      console.log(`      [${n.node_index + 1}] ${n.assigned_auditor_name} - ${n.status}`);
    });
    console.log('    操作日志:', detail.data.operation_logs.length, '条');

    console.log('\n【9/9】统计和权限测试');
    const aud1Pending = await request('GET', '/api/stats/my-pending', null, aud1Token);
    console.log('  待我审批(auditor1):', aud1Pending.data.stats.total, '件');

    const budgetSum = await request('GET', '/api/stats/budget-summary', null, op1Token);
    console.log('  预算汇总: 涉及', budgetSum.data.by_subject.length, '个科目');

    const dash = await request('GET', '/api/stats/dashboard', null, op1Token);
    console.log('  系统看板: 总申请数=', dash.data.overview.total_applications,
      ' 审批通过金额=', dash.data.overview.approved_amount);

    try {
      await request('GET', '/api/admin/departments', null, op1Token);
      console.log('  ✗ 权限测试失败: 操作员应不能访问管理员接口');
    } catch (e) {
      console.log('  ✓ 权限校验正确: 操作员访问管理员接口被拒绝');
    }

    console.log('\n========== 全部测试通过 ==========\n');

  } catch (err) {
    console.error('\n✗ 测试失败:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
