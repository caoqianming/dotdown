# 设置代理环境变量
$env:HTTP_PROXY = "http://127.0.0.1:7897"
$env:HTTPS_PROXY = "http://127.0.0.1:7897"

# 调用 claude 命令，传递所有参数
& "claude" @args

# 检查上一条命令的退出代码
if ($LASTEXITCODE -ne 0) {
    Write-Host "按任意键继续..." -ForegroundColor Yellow
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}