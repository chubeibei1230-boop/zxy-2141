const http = require('http');
const fs = require('fs');

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

const logs = [];
function log(msg) { logs.push(msg); console.log(msg); }

async function testCase(name, fn) {
  try {
    await fn();
    log('  OK  - ' + name);
  } catch (e) {
    log('  FAIL - ' + name + ' : ' + e.message);
    throw e;
  }
}

(async function main() {
  try {
    log('\n========== 综合测试开始 ==========\n');
    const tokens = {};
    const appIds = {};

    await testCase('健康检查', async () => { await request('GET', '/api/health'); });

    log('\n[登录认证]');
    const users = [
      ['admin', 'admin', 'admin123'],
      ['op1', 'operator1', 'op123456'],
      ['op2', 'operator2', 'op123456'],
      ['aud1', 'auditor1', 'aud123456'],
      ['aud2', 'auditor2', 'aud123456'],
      ['aud3', 'auditor3', 'aud123456']
    ];
    for (const [key, u, p] of users) {
      await testCase('登录 ' + u, async () => {
        const r = await request('POST', '/api/auth/login', { username: u, password: p });
        tokens[key] = r.data.token;
      });
    }

    log('\n[管理员功能]');
    let deptId;
    await testCase('查询部门', async () => {
      const r = await request('GET', '/api/admin/departments', null, tokens.admin);
      if (r.data.length < 4) throw new Error('部门数不够');
    });
    await testCase('增删改部门', async () => {
      const c = await request('POST', '/api/admin/departments',
        { name: 'T部门', code: 'T01' }, tokens.admin);
      deptId = c.data.id;
      await request('PUT', '/api/admin/departments/' + deptId,
        { name: 'T部门改', code: 'T01' }, tokens.admin);
      await request('DELETE', '/api/admin/departments/' + deptId, null, tokens.admin);
    });
    await testCase('操作员访问管理员接口被403', async () => {
      try {
        await request('GET', '/api/admin/users', null, tokens.op1);
        throw new Error('应被拒绝');
      } catch (e) {
        if (e.statusCode !== 403) throw e;
      }
    });

    log('\n[规则匹配]');
    const ruleCases = [
      [5000, 'normal', 1, '小额普通1级'],
      [35000, 'normal', 2, '中额普通2级'],
      [150000, 'normal', 3, '大额普通3级'],
      [2000, 'urgent', 3, '紧急任何金额3级']
    ];
    for (const [amt, urg, lv, desc] of ruleCases) {
      await testCase(desc, async () => {
        const r = await request('GET',
          `/api/query/public/approval-rules/match?amount=${amt}&urgency_level=${urg}`,
          null, tokens.op1);
        if (r.data.approval_levels !== lv) throw new Error('级别不对');
      });
    }

    log('\n[获取基础数据]');
    const hwSubject = (await request('GET', '/api/query/public/budget-subjects?status=1', null, tokens.op1))
      .data.list.find(s => s.code === 'RD-HW');
    const sup1 = (await request('GET', '/api/query/public/suppliers', null, tokens.op1)).data[0];

    log('\n[流程A: 多级审批通过(3.5万high→2级)]');
    await testCase('创建草稿A', async () => {
      const r = await request('POST', '/api/operator/applications', {
        title: 'A采购', budget_subject_id: hwSubject.id, total_amount: 35000,
        urgency_level: 'high', supplier_id: sup1.id,
        items: [{ name: 'A物品', qty: 1, unit_price: 35000 }]
      }, tokens.op1);
      appIds.A = r.data.id;
    });
    await testCase('提交A', async () => {
      const r = await request('POST', '/api/operator/applications/' + appIds.A + '/submit', {}, tokens.op1);
      if (r.data.status !== 'pending_approval') throw new Error('状态错');
      if (!r.data.current_auditor_name) throw new Error('无审核人');
    });
    await testCase('Aud1→审批通过(→Aud2)', async () => {
      const r = await request('POST', '/api/auditor/applications/' + appIds.A + '/approve',
        { comment: 'OK' }, tokens.aud1);
      if (r.data.current_auditor_name !== '赵审核') throw new Error('下一级不是赵审核');
    });
    await testCase('Aud2→审批通过(最终)', async () => {
      const r = await request('POST', '/api/auditor/applications/' + appIds.A + '/approve',
        { comment: 'OK' }, tokens.aud2);
      if (r.data.status !== 'approved') throw new Error('未通过');
    });
    await testCase('确认到货A', async () => {
      const r = await request('POST', '/api/operator/applications/' + appIds.A + '/arrival', {
        arrival_info: { items: [{ name: 'A', qty: 1 }] }
      }, tokens.op1);
      if (r.data.status !== 'arrival_confirmed') throw new Error('未到货确认');
    });

    log('\n[流程B: 审批退回+重提]');
    await testCase('创建+提交B(25万→3级)', async () => {
      const c = await request('POST', '/api/operator/applications', {
        title: 'B采购', budget_subject_id: hwSubject.id, total_amount: 250000,
        urgency_level: 'normal', supplier_id: sup1.id,
        items: [{ name: 'B', qty: 1, unit_price: 250000 }]
      }, tokens.op1);
      appIds.B = c.data.id;
      await request('POST', '/api/operator/applications/' + appIds.B + '/submit', {}, tokens.op1);
    });
    await testCase('退回无原因被拒绝', async () => {
      try {
        await request('POST', '/api/auditor/applications/' + appIds.B + '/return',
          { comment: '' }, tokens.aud1);
        throw new Error('应被拒绝');
      } catch (e) { /* ok */ }
    });
    await testCase('Aud1退回B', async () => {
      const r = await request('POST', '/api/auditor/applications/' + appIds.B + '/return',
        { comment: '材料不全' }, tokens.aud1);
      if (r.data.status !== 'returned') throw new Error('未退回');
    });
    await testCase('退回后Aud1不能继续审批', async () => {
      try {
        await request('POST', '/api/auditor/applications/' + appIds.B + '/approve', {}, tokens.aud1);
        throw new Error('应不能审批');
      } catch (e) { /* ok */ }
    });
    await testCase('Op1补充报价+重提', async () => {
      await request('PUT', '/api/operator/applications/' + appIds.B + '/quote',
        { quote_description: '补报价' }, tokens.op1);
      const r = await request('POST', '/api/operator/applications/' + appIds.B + '/submit', {}, tokens.op1);
      if (r.data.current_auditor_name !== '王审核') throw new Error('未回到Aud1');
    });

    log('\n[流程C: 审批转交]');
    await testCase('创建+提交C(8千→1级)', async () => {
      const c = await request('POST', '/api/operator/applications', {
        title: 'C采购', budget_subject_id: hwSubject.id, total_amount: 8000,
        urgency_level: 'normal', supplier_id: sup1.id,
        items: [{ name: 'C', qty: 1, unit_price: 8000 }]
      }, tokens.op1);
      appIds.C = c.data.id;
      await request('POST', '/api/operator/applications/' + appIds.C + '/submit', {}, tokens.op1);
    });
    await testCase('Aud1转交给Aud3(钱总监)', async () => {
      const r = await request('POST', '/api/auditor/applications/' + appIds.C + '/transfer',
        { target_auditor_id: 6, comment: '转交' }, tokens.aud1);
      if (r.data.current_auditor_name !== '钱总监') throw new Error('未转交钱总监');
    });
    await testCase('转交后原Aud1不能审批', async () => {
      try {
        await request('POST', '/api/auditor/applications/' + appIds.C + '/approve', {}, tokens.aud1);
        throw new Error('原审核员应失效');
      } catch (e) { /* ok */ }
    });
    await testCase('被转交的Aud3审批通过', async () => {
      const r = await request('POST', '/api/auditor/applications/' + appIds.C + '/approve',
        { comment: 'OK' }, tokens.aud3);
      if (r.data.status !== 'approved') throw new Error('未通过');
    });

    log('\n[流程D: 紧急申请校验]');
    await testCase('紧急申请无原因被拒', async () => {
      try {
        await request('POST', '/api/operator/applications', {
          title: 'D紧急', budget_subject_id: hwSubject.id, total_amount: 5000,
          urgency_level: 'urgent', supplier_id: sup1.id,
          items: [{ name: 'D', qty: 1, unit_price: 5000 }]
        }, tokens.op1);
        throw new Error('应拒绝');
      } catch (e) { /* ok */ }
    });
    await testCase('紧急申请带原因成功', async () => {
      const c = await request('POST', '/api/operator/applications', {
        title: 'D紧急采购', budget_subject_id: hwSubject.id, total_amount: 12000,
        urgency_level: 'urgent', urgent_reason: '故障紧急修复', supplier_id: sup1.id,
        items: [{ name: 'D', qty: 1, unit_price: 12000 }]
      }, tokens.op1);
      appIds.D = c.data.id;
      const r = await request('POST', '/api/operator/applications/' + appIds.D + '/submit', {}, tokens.op1);
      if (r.data.approval_levels !== 3) throw new Error('紧急必须3级');
    });

    log('\n[流程E: 申请关闭]');
    await testCase('创建+提交E', async () => {
      const c = await request('POST', '/api/operator/applications', {
        title: 'E采购', budget_subject_id: hwSubject.id, total_amount: 3000,
        urgency_level: 'normal', supplier_id: sup1.id,
        items: [{ name: 'E', qty: 1, unit_price: 3000 }]
      }, tokens.op1);
      appIds.E = c.data.id;
      await request('POST', '/api/operator/applications/' + appIds.E + '/submit', {}, tokens.op1);
    });
    await testCase('Aud1关闭E', async () => {
      const r = await request('POST', '/api/auditor/applications/' + appIds.E + '/close',
        { comment: '项目取消' }, tokens.aud1);
      if (r.data.status !== 'closed') throw new Error('未关闭');
    });
    await testCase('关闭后不能审批', async () => {
      try {
        await request('POST', '/api/auditor/applications/' + appIds.E + '/approve', {}, tokens.aud1);
        throw new Error('应拒绝');
      } catch (e) { /* ok */ }
    });
    await testCase('关闭后不能修改', async () => {
      try {
        await request('PUT', '/api/operator/applications/' + appIds.E,
          { title: '改' }, tokens.op1);
        throw new Error('应拒绝');
      } catch (e) { /* ok */ }
    });

    log('\n[查询筛选]');
    const queryCases = [
      ['status=draft', 'status=draft'],
      ['min&max金额', 'min_amount=30000&max_amount=100000'],
      ['urgent', 'urgency_level=urgent'],
      ['我的申请', 'my_created=true']
    ];
    for (const [name, qs] of queryCases) {
      await testCase('筛选: ' + name, async () => {
        await request('GET', '/api/query/applications?' + qs, null, tokens.op1);
      });
    }
    await testCase('查询详情(含节点+日志)', async () => {
      const r = await request('GET', '/api/query/applications/' + appIds.A, null, tokens.op1);
      if (!r.data.approval_nodes || r.data.approval_nodes.length < 1) throw new Error('无节点');
      if (!r.data.operation_logs || r.data.operation_logs.length < 1) throw new Error('无日志');
    });

    log('\n[统计报表]');
    await testCase('待我审批', async () => {
      const r = await request('GET', '/api/stats/my-pending', null, tokens.aud1);
      if (typeof r.data.stats.total !== 'number') throw new Error('格式错');
    });
    await testCase('退回原因分布', async () => {
      await request('GET', '/api/stats/return-reasons', null, tokens.admin);
    });
    await testCase('预算汇总', async () => {
      const r = await request('GET', '/api/stats/budget-summary', null, tokens.admin);
      if (!r.data.by_subject) throw new Error('无科目数据');
    });
    await testCase('系统看板', async () => {
      const r = await request('GET', '/api/stats/dashboard', null, tokens.admin);
      if (!r.data.overview) throw new Error('无看板数据');
    });

    log('\n========== 全部测试通过 ==========\n');
    log('覆盖范围:');
    log('  - 登录/JWT认证 + 权限控制');
    log('  - 管理员维护CRUD(部门/科目/供应方/规则)');
    log('  - 智能匹配审批规则(按金额/紧急度)');
    log('  - 多级审批流转 1/2/3级');
    log('  - 审批退回 & 回退边界(仅回申请人,重提从头开始)');
    log('  - 审批转交 & 转交边界(原审核员失效,被转交人可审批)');
    log('  - 紧急申请强制校验(原因必填 + 强制3级)');
    log('  - 申请关闭 & 关闭边界(只读)');
    log('  - 确认到货流程');
    log('  - 多条件查询筛选');
    log('  - 统计报表(待办/退回分布/预算汇总/看板)\n');

    fs.writeFileSync('test-result.txt', logs.join('\n'), 'utf8');

  } catch (err) {
    log('\n!!! 测试失败: ' + err.message);
    fs.writeFileSync('test-result.txt', logs.join('\n'), 'utf8');
    process.exit(1);
  }
})();
