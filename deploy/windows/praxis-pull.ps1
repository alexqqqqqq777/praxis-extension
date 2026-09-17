<#
  Praxis: забрати свіжий зріз із вузла корпусу (Mac Studio) — частинами, паралельно, з перевіркою.
  Працює на Windows PowerShell 5.1. Потрібні curl.exe (є в Windows) і zstd.exe (winget install Facebook.Zstandard).

  Корпус щоночі публікує:  http://100.118.205.24:8799/<канал>/manifest.json  (лише всередині Tailscale)
  Скрипт: маніфест -> чи є новіша версія -> частини по 32 МБ у кілька потоків -> sha256 кожної ->
          склеїти -> zstd -d -> sha256 бази -> файл <db>.ready.  Обірвалося — докачує лише те, чого бракує.
  Підміну робочої бази робить окремий крок (-Install): зупинити задачу, замінити файл, запустити.

    powershell -ExecutionPolicy Bypass -File praxis-pull.ps1                 # лише забрати й перевірити
    powershell -ExecutionPolicy Bypass -File praxis-pull.ps1 -Install        # і підмінити C:\praxis\praxis.db
#>
param(
  [string]$Channel = "praxis-full",
  [string]$Base    = "http://100.118.205.24:8799",
  [string]$Dir     = "C:\praxis\incoming",
  [string]$Target  = "C:\praxis\praxis.db",
  [string]$Task    = "PraxisCards",
  # служба може слухати 127.0.0.1 або лише адресу Tailscale — пробуємо по черзі
  [string[]]$HealthUrls = @("http://127.0.0.1:8788/health", "http://100.70.93.113:8788/health"),
  [int]$Streams    = 8,
  [switch]$Install,
  [switch]$Force
)
$ErrorActionPreference = "Stop"
$sw = [Diagnostics.Stopwatch]::StartNew()
function Sha($p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() }
function Say($t) { "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $t }

New-Item -ItemType Directory -Force $Dir | Out-Null
$m = Invoke-RestMethod -Uri "$Base/$Channel/manifest.json" -TimeoutSec 60
$stateFile = Join-Path $Dir "$Channel.version"
$ready = Join-Path $Dir ($m.db_name + ".ready")
if (-not $Force -and (Test-Path $stateFile) -and ((Get-Content $stateFile -Raw).Trim() -eq $m.version) -and (Test-Path $ready)) {
  Say "уже свіжий: $($m.version)"
} else {
  $need = [long]$m.db_size + [long]$m.compressed.size * 2 + 1GB
  $free = (Get-PSDrive ($Dir.Substring(0,1))).Free
  if ($free -lt $need) { throw "мало місця: вільно $([math]::Round($free/1GB,1)) ГБ, треба $([math]::Round($need/1GB,1)) ГБ" }
  $pdir = Join-Path $Dir "$Channel.$($m.version).parts"
  New-Item -ItemType Directory -Force $pdir | Out-Null
  Say "версія $($m.version): $([math]::Round($m.compressed.size/1MB)) МБ у $($m.compressed.parts.Count) частинах"
  for ($round = 1; $round -le 5; $round++) {
    $todo = @($m.compressed.parts | Where-Object {
      $f = Join-Path $pdir $_.name
      -not ((Test-Path $f) -and ((Get-Item $f).Length -eq $_.size) -and ((Sha $f) -eq $_.sha256)) })
    if ($todo.Count -eq 0) { break }
    Say "коло $round`: тягну $($todo.Count) частин у $Streams потоків"
    for ($i = 0; $i -lt $todo.Count; $i += $Streams) {
      $batch = $todo[$i..([Math]::Min($i + $Streams - 1, $todo.Count - 1))]
      $procs = $batch | ForEach-Object {
        Start-Process curl.exe -NoNewWindow -PassThru -ArgumentList @(
          "-s", "-S", "--fail", "--retry", "3", "--connect-timeout", "20",
          "-o", (Join-Path $pdir $_.name), ($m.base_url + $_.name)) }
      $procs | Wait-Process
    }
  }
  $bad = @($m.compressed.parts | Where-Object { (Sha (Join-Path $pdir $_.name)) -ne $_.sha256 })
  if ($bad.Count) { throw "не зійшлися контрольні суми частин: $($bad.name -join ', ')" }

  $zst = Join-Path $Dir ($m.db_name + ".zst")
  $out = [IO.File]::Create($zst)
  try { foreach ($p in $m.compressed.parts) { $in = [IO.File]::OpenRead((Join-Path $pdir $p.name)); try { $in.CopyTo($out) } finally { $in.Close() } } }
  finally { $out.Close() }
  $new = Join-Path $Dir ($m.db_name + ".new")
  & zstd.exe -d -f -q $zst -o $new
  if ($LASTEXITCODE -ne 0) { throw "zstd -d завершився з кодом $LASTEXITCODE" }
  if ((Get-Item $new).Length -ne [long]$m.db_size) { throw "розмір бази не той" }
  if ((Sha $new) -ne $m.db_sha256) { throw "sha256 бази не збігається з маніфестом" }
  Move-Item -Force $new $ready
  Remove-Item -Force $zst
  Remove-Item -Recurse -Force $pdir
  Get-ChildItem $Dir -Directory -Filter "$Channel.*.parts" | Remove-Item -Recurse -Force
  Set-Content -Path $stateFile -Value $m.version -Encoding ASCII
  Say "готово: $ready — зріз від $($m.built_at), схема $($m.schema_version), $([math]::Round($sw.Elapsed.TotalMinutes,1)) хв"
}

if ($Install) {
  if (-not (Test-Path $ready)) { throw "немає перевіреного файла $ready" }
  Say "підміна: зупиняю задачу $Task"
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'praxis_http|cards_api' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 2
  $prev = "$Target.prev"
  if (Test-Path $Target) { Move-Item -Force $Target $prev }
  Move-Item -Force $ready $Target
  Get-ChildItem (Split-Path $Target) -Filter ".cards_counts_*.json" -Force -ErrorAction SilentlyContinue | Remove-Item -Force
  Start-ScheduledTask -TaskName $Task
  Start-Sleep -Seconds 5
  $alive = $null
  foreach ($u in $HealthUrls) {
    try { $h = Invoke-RestMethod -Uri $u -TimeoutSec 30; $alive = $u
          Say ("служба відповіла на " + $u + ": " + ($h | ConvertTo-Json -Compress)); break } catch { }
  }
  if (-not $alive) {
    Say "УВАГА: /health не відповів ні на одній адресі — повертаю попередню базу"
    Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
    Start-Sleep 2
    Move-Item -Force $Target "$Target.failed"; Move-Item -Force $prev $Target
    Start-ScheduledTask -TaskName $Task
    throw "підміну відкочено"
  }
}
