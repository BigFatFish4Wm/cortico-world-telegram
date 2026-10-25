# 一键把 cortico-world-telegram 装进 Coopanion（Windows）
# 用法：在仓库目录里右键“使用 PowerShell 运行”，或执行  .\install.ps1
$ErrorActionPreference = 'Stop'
$repoDir = $PSScriptRoot

$dataLoc = Join-Path $env:LOCALAPPDATA 'Coopanion\data-location.json'
if (-not (Test-Path -LiteralPath $dataLoc)) {
  throw "找不到 $dataLoc。先启动一次 Coopanion，再来运行这个脚本。"
}
$data = (Get-Content -LiteralPath $dataLoc -Raw | ConvertFrom-Json).data
if (-not $data) { throw "data-location.json 里没有 data 字段：$dataLoc" }

$ext = Join-Path $data 'extensions'
if (-not (Test-Path -LiteralPath $ext)) { throw "找不到 Coopanion 扩展目录：$ext" }

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host "没有找到 pnpm。先装它：npm install -g pnpm" -ForegroundColor Yellow
  throw '缺少 pnpm'
}

# 跟 Coopanion 现有的包仓库保持一致，免得 pnpm 报 store 冲突
$storeArgs = @()
$modules = Join-Path $ext 'node_modules\.modules.yaml'
if (Test-Path -LiteralPath $modules) {
  try {
    $meta = Get-Content -LiteralPath $modules -Raw | ConvertFrom-Json
    if ($meta.storeDir) { $storeArgs = @('--store-dir', $meta.storeDir) }
  } catch {
    # 解析不了就不带参数，pnpm 自己会给出提示
  }
}

Write-Host "Coopanion 数据目录：$data"
Write-Host "扩展目录：$ext"
Write-Host ""

Push-Location -LiteralPath $ext
try {
  & pnpm add "link:$repoDir" @storeArgs
  if ($LASTEXITCODE -ne 0) { throw "pnpm add 失败（exit $LASTEXITCODE）" }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "装好了。" -ForegroundColor Green
Write-Host "完全退出 Coopanion（含托盘）再打开，设置里会出现「Telegram 机器人」。" -ForegroundColor Green
Write-Host "填 Bot Token，再把自己的 chat id 填进「主人会话」就够了。" -ForegroundColor Green
