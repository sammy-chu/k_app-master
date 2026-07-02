param(
    [string]$BackendUrl = "https://subaru-proposition-bringing-marketing.trycloudflare.com",
    [string]$ServerIp = "39.107.112.227"
)

$configFile = "C:\Users\sami\Desktop\k_app-master-production-only\k_app-master-production-only\deployment-templates\nginx.conf"

if (-not (Test-Path $configFile)) {
    Write-Host "Error: Cannot find nginx.conf at $configFile" -ForegroundColor Red
    exit 1
}

$content = Get-Content $configFile

# Replace server_name
# Match "server_name app.yourdomain.com;" or similar
$content = $content -replace 'server_name\s+[^;]+;', "server_name $ServerIp;"

# Replace API_BASE injection
# Match sub_filter '<head>' '<head><script>window.API_BASE="...";</script>';
$content = $content -replace 'sub_filter\s+''<head>''\s+''<head><script>window\.API_BASE="[^"]*";</script>'';', "sub_filter '<head>' '<head><script>window.API_BASE=""$BackendUrl"";</script>';"

Set-Content -Path $configFile -Value $content

Write-Host "Successfully updated nginx.conf:" -ForegroundColor Green
Write-Host "- server_name set to: $ServerIp"
Write-Host "- window.API_BASE set to: $BackendUrl"
Write-Host ""
Write-Host "Now you can SCP the config to your server:" -ForegroundColor Cyan
Write-Host "scp deployment-templates/nginx.conf root@${ServerIp}:/etc/nginx/conf.d/k-app.conf"
