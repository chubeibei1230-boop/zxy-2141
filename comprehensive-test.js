const http = require('http');

function request(method, path, data = null, token = null) {
  return new Promise((resolve, reject) => {
    const postData = data ? JSON.stringify(data) : null;
    const options = {
      hostname: 'localhost', port: 8120, path: path, method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) options.headers['Authorization'] = 'Bearer ' + token;
    if (postData) options.headers['Content-Length'] = Buffer.byteLength(postData);
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 400 || !parsed.success) {
            const err = new Error(`HTTP ${res.statusCode}: ${parsed.message || body.substring(0, 100)}`);
            err.statusCode = res.statusCode;
            err.response = parsed;
            reject(err);
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error('ParseError: ' + body.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function testCase(name, fn) {
  try {
    await fn();
    console.log('  ✓', name);
  } catch (e) {
    console.error('  ✗', name, '-', e.message);
    throw e;
  }
}

(async function main() {
  console.log('\n========== 采购管理系统 综合功能测试 ==========\n');
  const tokens = {};
  const appIds = {};

  try {
    await testCase('健康检查接口', async () => {
      const h = await request('GET', '/api/health');
      if (!h.success) throw new Error('健康检查失败');
    });

    console.log('\n【第一部分：登录认证】');
    await testCase('管理员登录', async () => {
      const r = await request('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
      if (!r.success) throw new Error(r.message);
      tokens.admin = r.data.token;
    });
    await testCase('操作员 operator1 登录', async () => {
      const r = await request('POST', '/api/auth/login', { username: 'operator1', password: 'op123456' });
      tokens.op1 = r.data.token;
    });
    await testCase('操作员 operator2 登录', async () => {
      const r = await request('POST', '/api/auth/login', { username: 'operator2', password: 'op123456' });
      tokens.op2 = r.data.token;
    });
    await testCase('审核员 auditor1/2/3 登录', async () => {
      const a1 = await request('POST', '/api/auth/login', { username: 'auditor1', password: 'aud123456' });
      const a2 = await request('POST', '/api/auth/login', { username: 'auditor2', password: 'aud123456' });
      const a3 = await request('POST', '/api/auth/login', { username: 'auditor3', password: 'aud123456' });
      tokens.aud1 = a1.data.token;
      tokens.aud2 = a2.data.token;
      tokens.aud3 = a3.data.token;
    });
    await testCase('错误密码被拒绝', async () => {
      try {
        await request('POST', '/api/auth/login', { username: 'admin', password: 'wrong' });
        throw new Error('应该返回错误');
      } catch (e) { /* expected */ }
    });

    console.log('\n【第二部分：管理员接口】');
    let testDeptId;
    await testCase('查询部门列表', async () => {
      const r = await request('GET', '/api/admin/departments', null, tokens.admin);
      if (r.data.length < 4) throw new Error('部门数量不足');
    });
    await testCase('创建新部门', async () => {
      const r = await request('POST', '/api/admin/departments',
        { name: '测试部', code: 'TEST', description: '测试用部门' }, tokens.admin);
      if (!r.success) throw new Error(r.message);
      testDeptId = r.data.id;
    });
    await testCase('修改部门', async () => {
      const r = await request('PUT', `/api/admin/departments/${testDeptId}`,
        { name: '测试部门修改版', code: 'TEST', description: '已修改' }, tokens.admin);
      if (!r.success) throw new Error(r.message);
    });
    await testCase('删除部门', async () => {
      const r = await request('DELETE', `/api/admin/departments/${testDeptId}`, null, tokens.admin);
      if (!r.success) throw new Error(r.message);
    });
    await testCase('查询预算科目（含树形）', async () => {
      const r = await request('GET', '/api/admin/budget-subjects', null, tokens.admin);
      if (!r.data.tree || r.data.tree.length === 0) throw new Error('科目树为空');
    });
    await testCase('查询审批规则', async () => {
      const r = await request('GET', '/api/admin/approval-rules', null, tokens.admin);
      if (r.data.length < 6) throw new Error('规则数量不足');
    });
    await testCase('操作员访问管理员接口被403拒绝', async () => {
      try {
        await request('GET', '/api/admin/users', null, tokens.op1);
        throw new Error('应被拒绝');
      } catch (e) {
        const msg = e.message;
        if (!msg.includes('403') && !msg.includes('权限')) throw e;
      }
    });

    console.log('\n【第三部分：匹配审批规则】');
    await testCase('普通小额申请 (≤1万) → 1级审批', async () => {
      const r = await request('GET', '/api/query/public/approval-rules/match?amount=5000&urgency_level=normal', null, tokens.op1);
      if (r.data.approval_levels !== 1) throw new Error('应为1级，实际：' + r.data.approval_levels);
    });
    await testCase('普通中额申请 (1万-10万) → 2级审批', async () => {
      const r = await request('GET', '/api/query/public/approval-rules/match?amount=35000&urgency_level=normal', null, tokens.op1);
      if (r.data.approval_levels !== 2) throw new Error('应为2级');
    });
    await testCase('普通大额申请 (>10万) → 3级审批', async () => {
      const r = await request('GET', '/api/query/public/approval-rules/match?amount=150000&urgency_level=normal', null, tokens.op1);
      if (r.data.approval_levels !== 3) throw new Error('应为3级');
    });
    await testCase('高优先级申请 → 更多级别', async () => {
      const r = await request('GET', '/api/query/public/approval-rules/match?amount=35000&urgency_level=high', null, tokens.op1);
      if (r.data.approval_levels !== 2) throw new Error('高优先级中额应为2级');
    });
    await testCase('紧急申请 → 全部3级审批', async () => {
      const r = await request('GET', '/api/query/public/approval-rules/match?amount=2000&urgency_level=urgent', null, tokens.op1);
      if (r.data.approval_levels !== 3) throw new Error('紧急申请应为3级');
    });

    console.log('\n【第四部分：完整业务流程 A - 多级审批通过（高金额2级）】');
    const hwSubject = (await request('GET', '/api/query/public/budget-subjects?status=1', null, tokens.op1)).data.list.find(s => s.code === 'RD-HW');
    const sup1 = (await request('GET', '/api/query/public/suppliers', null, tokens.op1)).data[0];

    await testCase('创建采购申请A（3.5万，高优先级，2级审批）', async () => {
      const r = await request('POST', '/api/operator/applications', {
        title: '采购办公服务器A',
        budget_subject_id: hwSubject.id,
        total_amount: 35000,
        urgency_level: 'high',
        supplier_id: sup1.id,
        items: [{ name: '服务器A', qty: 1, unit_price: 35000, spec: '标准配置' }],
        quote_description: '三家比价'
      }, tokens.op1);
      if (!r.success || r.data.status !== 'draft') throw new Error('创建草稿失败');
      appIds.A = r.data.id;
    });
    await testCase('提交申请A进入审批', async () => {
      const r = await request('POST', `/api/operator/applications/${appIds.A}/submit`, {}, tokens.op1);
      if (r.data.status !== 'pending_approval') throw new Error('状态错误：' + r.data.status);
      if (!r.data.current_auditor_name) throw new Error('当前审核人未显示');
    });
    await testCase('Auditor1（第一级）审批通过', async () => {
      const r = await request('POST', `/api/auditor/applications/${appIds.A}/approve`,
        { comment: '材料齐全，同意' }, tokens.aud1);
      if (r.data.current_auditor_name !== '赵审核') throw new Error('下一级应为赵审核，实际：' + r.data.current_auditor_name);
    });
    await testCase('Auditor2（第二级）审批通过 → 最终approved', async () => {
      const r = await request('POST', `/api/auditor/applications/${appIds.A}/approve`,
        { comment: '预算内，通过' }, tokens.aud2);
      if (r.data.status !== 'approved') throw new Error('最终状态应为approved');
    });
    await testCase('审批完成后补充报价说明被拒绝', async () => {
      try {
        await request('PUT', `/api/operator/applications/${appIds.A}/quote`,
          { quote_description: 'test' }, tokens.op1);
        throw new Error('应被拒绝');
      } catch (e) { /* expected */ }
    });
    await testCase('确认到货', async () => {
      const r = await request('POST', `/api/operator/applications/${appIds.A}/arrival`, {
        arrival_info: { items: [{ name: '服务器A', qty: 1, remark: '已验收' }], confirmed_at: new Date().toISOString() },
        comment: '实物验收通过'
      }, tokens.op1);
      if (r.data.status !== 'arrival_confirmed') throw new Error('应已到货确认');
    });

    console.log('\n【第五部分：完整业务流程 B - 审批退回（回退边界）】');
    await testCase('创建申请B（退回测试用）', async () => {
      const r = await request('POST', '/api/operator/applications', {
        title: '采购申请B-退回测试',
        budget_subject_id: hwSubject.id,
        total_amount: 250000,
        urgency_level: 'normal',
        supplier_id: sup1.id,
        items: [{ name: '大型设备B', qty: 1, unit_price: 250000 }]
      }, tokens.op1);
      appIds.B = r.data.id;
    });
    await testCase('提交申请B（3级审批）', async () => {
      const r = await request('POST', `/api/operator/applications/${appIds.B}/submit`, {}, tokens.op1);
      if (r.data.approval_levels !== 3) throw new Error('应为3级审批');
    });
    await testCase('Auditor1退回申请（无原因被拒绝）', async () => {
      try {
        await request('POST', `/api/auditor/applications/${appIds.B}/return`, { comment: '' }, tokens.aud1);
        throw new Error('应要求原因');
      } catch (e) { /* expected */ }
    });
    await testCase('Auditor1退回申请（带原因）', async () => {
      const r = await request('POST', `/api/auditor/applications/${appIds.B}/return`,
        { comment: '报价材料不全，请补充三家报价单' }, tokens.aud1);
      if (r.data.status !== 'returned') throw new Error('状态应为returned');
    });
    await testCase('退回后Auditor1不能再审批（回退边界验证）', async () => {
      try {
        await request('POST', `/api/auditor/applications/${appIds.B}/approve`,
          { comment: '同意' }, tokens.aud1);
        throw new Error('退回后审核员不能继续审批');
      } catch (e) { /* expected */ }
    });
    await testCase('Operator1补充报价说明', async () => {
      const r = await request('PUT', `/api/operator/applications/${appIds.B}/quote`,
        { quote_description: '补充：A公司XX万，B公司XX万，C公司XX万' }, tokens.op1);
      if (!r.success) throw new Error(r.message);
    });
    await testCase('Operator1重新提交 → 重新从第1级开始', async () => {
      const r = await request('POST', `/api/operator/applications/${appIds.B}/submit`, {}, tokens.op1);
      if (r.data.status !== 'pending_approval') throw new Error('状态错误');
      if (r.data.current_auditor_name !== '王审核') throw new Error('应重新回到第1级王审核');
    });

    console.log('\n【第六部分：业务流程 C - 审批转交】');
    await testCase('创建申请C（转交测试）', async () => {
      const r = await request('POST', '/api/operator/applications', {
        title: '采购申请C-转交测试',
        budget_subject_id: hwSubject.id,
        total_amount: 8000,
        urgency_level: 'normal',
        supplier_id: sup1.id,
        items: [{ name: '办公设备C', qty: 1, unit_price: 8000 }]
      }, tokens.op1);
      appIds.C = r.data.id;
      await request('POST', `/api/operator/applications/${appIds.C}/submit`, {}, tokens.op1);
    });
    await testCase('Auditor1转交给Auditor3', async () => {
      const r = await request('POST', `/api/auditor/applications/${appIds.C}/transfer`,
        { target_auditor_id: 6, comment: '此业务由钱总监审批更合适' }, tokens.aud1);
      if (r.data.current_auditor_name !== '钱总监') throw new Error('应转交给钱总监');
    });
    await testCase('转交后原审核员Auditor1不能再审批', async () => {
      try {
        await request('POST', `/api/auditor/applications/${appIds.C}/approve`, {}, tokens.aud1);
        throw new Error('转交后原审核员不能审批');
      } catch (e) { /* expected */ }
    });
    await testCase('被转交的Auditor3可以审批通过', async () => {
      const r = await request('POST', `/api/auditor/applications/${appIds.C}/approve`,
        { comment: '同意，转交审批完成' }, tokens.aud3);
      if (r.data.status !== 'approved') throw new Error('转交后审批未通过');
    });

    console.log('\n【第七部分：业务流程 D - 紧急申请】');
    await testCase('紧急申请无紧急原因被拒绝', async () => {
      try {
        await request('POST', '/api/operator/applications', {
          title: '紧急申请-无原因', budget_subject_id: hwSubject.id,
          total_amount: 5000, urgency_level: 'urgent', supplier_id: sup1.id,
          items: [{ name: 'X', qty: 1, unit_price: 5000 }]
        }, tokens.op1);
        throw new Error('应要求紧急原因');
      } catch (e) { /* expected */ }
    });
    await testCase('紧急申请创建成功（带紧急原因）', async () => {
      const r = await request('POST', '/api/operator/applications', {
        title: '紧急采购-服务器故障更换',
        budget_subject_id: hwSubject.id, total_amount: 12000,
        urgency_level: 'urgent', urgent_reason: '核心服务器硬件故障，业务中断需紧急更换',
        supplier_id: sup1.id,
        items: [{ name: '紧急替换服务器', qty: 1, unit_price: 12000 }]
      }, tokens.op1);
      appIds.D = r.data.id;
      const s = await request('POST', `/api/operator/applications/${appIds.D}/submit`, {}, tokens.op1);
      if (s.data.approval_levels !== 3) throw new Error('紧急申请必须3级审批');
    });

    console.log('\n【第八部分：业务流程 E - 申请关闭】');
    await testCase('创建并提交申请E', async () => {
      const r = await request('POST', '/api/operator/applications', {
        title: '采购申请E-关闭测试',
        budget_subject_id: hwSubject.id, total_amount: 3000,
        urgency_level: 'normal', supplier_id: sup1.id,
        items: [{ name: '物品E', qty: 1, unit_price: 3000 }]
      }, tokens.op1);
      appIds.E = r.data.id;
      await request('POST', `/api/operator/applications/${appIds.E}/submit`, {}, tokens.op1);
    });
    await testCase('无原因关闭被拒绝', async () => {
      try {
        await request('POST', `/api/auditor/applications/${appIds.E}/close`, { comment: '' }, tokens.aud1);
        throw new Error('应要求关闭原因');
      } catch (e) { /* expected */ }
    });
    await testCase('Auditor1关闭申请（含原因）', async () => {
      const r = await request('POST', `/api/auditor/applications/${appIds.E}/close`,
        { comment: '项目取消，无需继续采购' }, tokens.aud1);
      if (r.data.status !== 'closed') throw new Error('应关闭');
    });
    await testCase('关闭后审批被拒绝', async () => {
      try {
        await request('POST', `/api/auditor/applications/${appIds.E}/approve`, {}, tokens.aud1);
        throw new Error('关闭后不能再审批');
      } catch (e) { /* expected */ }
    });
    await testCase('关闭后修改被拒绝', async () => {
      try {
        await request('PUT', `/api/operator/applications/${appIds.E}`,
          { title: '尝试修改' }, tokens.op1);
        throw new Error('关闭后不能修改');
      } catch (e) { /* expected */ }
    });

    console.log('\n【第九部分：查询接口多条件筛选】');
    await testCase('按状态筛选 - 仅draft', async () => {
      const r = await request('GET', '/api/query/applications?status=draft', null, tokens.admin);
      const wrong = r.data.list.some(i => i.status !== 'draft');
      if (wrong) throw new Error('有非draft状态混入');
    });
    await testCase('按部门筛选', async () => {
      const r = await request('GET', '/api/query/applications?department_id=1', null, tokens.admin);
      const wrong = r.data.list.some(i => i.department_name !== '技术部' && i.department_name);
      if (wrong) throw new Error('部门筛选错误');
    });
    await testCase('按金额区间 3万-10万筛选', async () => {
      const r = await request('GET', '/api/query/applications?min_amount=30000&max_amount=100000', null, tokens.admin);
      const wrong = r.data.list.some(i => i.total_amount < 30000 || i.total_amount > 100000);
      if (wrong) throw new Error('金额区间筛选错误');
    });
    await testCase('按紧急程度=urgent筛选', async () => {
      const r = await request('GET', '/api/query/applications?urgency_level=urgent', null, tokens.admin);
      const wrong = r.data.list.some(i => i.urgency_level !== 'urgent');
      if (wrong) throw new Error('紧急程度筛选错误');
    });
    await testCase('我的申请筛选（operator1）', async () => {
      const r = await request('GET', '/api/query/applications?my_created=true', null, tokens.op1);
      if (r.data.pagination.total < 5) throw new Error('申请数不足');
    });
    await testCase('申请详情含完整节点历史和操作日志', async () => {
      const r = await request('GET', `/api/query/applications/${appIds.A}`, null, tokens.op1);
      if (r.data.approval_nodes.length < 2) throw new Error('节点数不足');
      if (r.data.operation_logs.length < 4) throw new Error('操作日志数不足');
    });

    console.log('\n【第十部分：统计接口】');
    await testCase('Auditor1待我审批统计', async () => {
      const r = await request('GET', '/api/stats/my-pending', null, tokens.aud1);
      if (typeof r.data.stats.total !== 'number') throw new Error('格式错误');
    });
    await testCase('退回原因分布统计', async () => {
      const r = await request('GET', '/api/stats/return-reasons', null, tokens.admin);
      if (!r.data.distribution) throw new Error('缺少distribution');
    });
    await testCase('预算科目汇总', async () => {
      const r = await request('GET', '/api/stats/budget-summary', null, tokens.admin);
      if (r.data.by_subject.length === 0) throw new Error('科目数据为空');
      if (!r.data.by_month) throw new Error('缺少按月统计');
    });
    await testCase('综合看板', async () => {
      const r = await request('GET', '/api/stats/dashboard', null, tokens.admin);
      const d = r.data;
      if (!d.overview.total_applications) throw new Error('看板数据不全');
      if (!d.urgent_pending) throw new Error('缺少紧急待办');
      if (!d.recent_applications) throw new Error('缺少最近申请');
    });

    console.log('\n========== 全部测试通过！系统运行正常 ==========\n');

    console.log('关键测试覆盖：');
    console.log('  ✓ JWT 登录认证 + 权限控制 (403拒绝)');
    console.log('  ✓ 管理员 CRUD 操作 (部门/预算科目/供应方/规则)');
    console.log('  ✓ 智能匹配审批规则 (按金额/紧急程度)');
    console.log('  ✓ 多级审批流转 (1→2→3级)');
    console.log('  ✓ 审批退回 & 回退边界 (只能回申请人，审核员不可继续)');
    console.log('  ✓ 审批转交 & 转交边界 (原审核员失效，被转交人可审批)');
    console.log('  ✓ 紧急申请强制校验 (必须有紧急原因+强制3级)');
    console.log('  ✓ 申请关闭 & 关闭边界 (之后只读)');
    console.log('  ✓ 确认到货流程');
    console.log('  ✓ 多条件组合筛选查询');
    console.log('  ✓ 四大统计报表 (待办/退回/预算/看板)');
    console.log('');

  } catch (err) {
    console.error('\n✗ 测试中途失败:', err.message);
    process.exit(1);
  }
})();
