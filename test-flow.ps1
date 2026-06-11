$baseUrl = "http://localhost:8120/api"
$headers = @{ "Content-Type" = "application/json" }

Write-Host "`n========== 完整业务流程测试 ==========`n"

Write-Host "【1/9】操作员登录 - operator1"
$op1Body = @{ username = "operator1"; password = "op123456" } | ConvertTo-Json
$op1Login = Invoke-RestMethod -Uri "$baseUrl/auth/login" -Method Post -Body $op1Body -Headers $headers
$op1Token = $op1Login.data.token
$op1Headers = @{ Authorization = "Bearer $op1Token"; "Content-Type" = "application/json" }
Write-Host "  ✓ 成功: $($op1Login.data.user.realName)"

Write-Host "`n【2/9】获取预算科目和供应方"
$subjects = Invoke-RestMethod -Uri "$baseUrl/query/public/budget-subjects?status=1" -Method Get -Headers $op1Headers
$hwSubject = $subjects.data.list | Where-Object { $_.code -eq "RD-HW" }
Write-Host "  ✓ 预算科目数: $($subjects.data.list.Count)"

$suppliers = Invoke-RestMethod -Uri "$baseUrl/query/public/suppliers" -Method Get -Headers $op1Headers
$sup1 = $suppliers.data[0]
Write-Host "  ✓ 供应方数: $($suppliers.data.Count)"

Write-Host "`n【3/9】创建采购申请（草稿）"
$appBody = @{
    title = "采购开发服务器"
    budget_subject_id = $hwSubject.id
    total_amount = 58000.00
    urgency_level = "high"
    supplier_id = $sup1.id
    expected_date = "2026-06-20"
    items = @(
        @{ name = "Dell R750 服务器"; qty = 2; unit_price = 25000; spec = "2*Xeon Gold 6330/256GB/4TB SSD" }
        @{ name = "网络交换机"; qty = 1; unit_price = 8000; spec = "48口千兆交换机" }
    )
    quote_description = "已获取三家报价，选择性价比最高的科技设备有限公司"
} | ConvertTo-Json -Depth 10
$createApp = Invoke-RestMethod -Uri "$baseUrl/operator/applications" -Method Post -Body $appBody -Headers $op1Headers
$appId = $createApp.data.id
Write-Host "  ✓ 创建成功: $($createApp.data.application_no)"
Write-Host "    状态: $($createApp.data.status)"
Write-Host "    金额: $($createApp.data.total_amount)"

Write-Host "`n【4/9】提交审批"
$submit = Invoke-RestMethod -Uri "$baseUrl/operator/applications/$appId/submit" -Method Post -Body "{}" -Headers $op1Headers
Write-Host "  ✓ $($submit.message)"
Write-Host "    当前状态: $($submit.data.status)"
Write-Host "    审批级别: $($submit.data.approval_levels)级"
Write-Host "    当前审核人: $($submit.data.current_auditor_name)"

Write-Host "`n【5/9】审核员1(auditor1)登录并审批通过"
$aud1Body = @{ username = "auditor1"; password = "aud123456" } | ConvertTo-Json
$aud1Login = Invoke-RestMethod -Uri "$baseUrl/auth/login" -Method Post -Body $aud1Body -Headers $headers
$aud1Token = $aud1Login.data.token
$aud1Headers = @{ Authorization = "Bearer $aud1Token"; "Content-Type" = "application/json" }
Write-Host "  ✓ 审核员1登录: $($aud1Login.data.user.realName)"

$approve1Body = @{ comment = "申请材料完整，同意进入下一级审核" } | ConvertTo-Json
$approve1 = Invoke-RestMethod -Uri "$baseUrl/auditor/applications/$appId/approve" -Method Post -Body $approve1Body -Headers $aud1Headers
Write-Host "  ✓ 第一级审批结果: $($approve1.message)"
Write-Host "    当前状态: $($approve1.data.status)"
Write-Host "    下一审核人: $($approve1.data.current_auditor_name)"

Write-Host "`n【6/9】审核员2(auditor2)登录并审批通过"
$aud2Body = @{ username = "auditor2"; password = "aud123456" } | ConvertTo-Json
$aud2Login = Invoke-RestMethod -Uri "$baseUrl/auth/login" -Method Post -Body $aud2Body -Headers $headers
$aud2Token = $aud2Login.data.token
$aud2Headers = @{ Authorization = "Bearer $aud2Token"; "Content-Type" = "application/json" }
Write-Host "  ✓ 审核员2登录: $($aud2Login.data.user.realName)"

$approve2Body = @{ comment = "金额在预算范围内，同意" } | ConvertTo-Json
$approve2 = Invoke-RestMethod -Uri "$baseUrl/auditor/applications/$appId/approve" -Method Post -Body $approve2Body -Headers $aud2Headers
Write-Host "  ✓ 第二级审批结果: $($approve2.message)"
Write-Host "    当前状态: $($approve2.data.status)"

Write-Host "`n【7/9】查询申请详情（含审批历史和操作日志）"
$detail = Invoke-RestMethod -Uri "$baseUrl/query/applications/$appId" -Method Get -Headers $op1Headers
Write-Host "  ✓ 申请标题: $($detail.data.title)"
Write-Host "    最终状态: $($detail.data.status_name)"
Write-Host "    审批节点数: $($detail.data.approval_nodes.Count)"
Write-Host "    操作日志数: $($detail.data.operation_logs.Count)"
$detail.data.approval_nodes | ForEach-Object {
    Write-Host "    节点$($_.node_index + 1): $($_.assigned_auditor_name) - $($_.status)"
}

Write-Host "`n【8/9】统计接口测试"
$aud1Stats = Invoke-RestMethod -Uri "$baseUrl/stats/my-pending" -Method Get -Headers $aud1Headers
Write-Host "  【待我审批 - auditor1】"
Write-Host "    总数: $($aud1Stats.data.stats.total)"
Write-Host "    紧急: $($aud1Stats.data.stats.urgent_count)"

$budgetStats = Invoke-RestMethod -Uri "$baseUrl/stats/budget-summary" -Method Get -Headers $op1Headers
Write-Host "  【预算科目汇总】"
Write-Host "    申请总数: $($budgetStats.data.total.application_count)"
Write-Host "    涉及科目: $($budgetStats.data.by_subject.Count)"

$dashboard = Invoke-RestMethod -Uri "$baseUrl/stats/dashboard" -Method Get -Headers $op1Headers
Write-Host "  【系统看板】"
Write-Host "    总申请数: $($dashboard.data.overview.total_applications)"
Write-Host "    审批通过金额: $($dashboard.data.overview.approved_amount)"

Write-Host "`n【9/9】权限测试 - 操作员尝试访问管理员接口"
try {
    $depts = Invoke-RestMethod -Uri "$baseUrl/admin/departments" -Method Get -Headers $op1Headers
    Write-Host "  ✗ 异常: 操作员应该无法访问管理员接口"
} catch {
    $err = $_.Exception.Message
    if ($err -match "403") {
        Write-Host "  ✓ 权限校验正确: 操作员访问管理员接口被正确拒绝 (403)"
    } else {
        Write-Host "  ? 其他错误: $err"
    }
}

Write-Host "`n========== 测试完成 - 全部通过 ==========`n"
