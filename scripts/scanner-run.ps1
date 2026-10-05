param(
  [Parameter(Mandatory = $true)][string]$JobDirectory,
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [Parameter(Mandatory = $true)][string]$ExpectedHash,
  [Parameter(Mandatory = $true)][int]$OwnerPid,
  [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
  [switch]$Elevated
)
$ErrorActionPreference = 'Stop'
$resultPath = Join-Path $JobDirectory 'result.json'
$cancelPath = Join-Path $JobDirectory 'cancel'
$scannerProcess = $null
$mutex = $null
$ownsMutex = $false
$stopRequested = $false

function Write-Result($result) {
  $temporary = Join-Path $JobDirectory 'result.tmp'
  [IO.File]::WriteAllText($temporary, ($result | ConvertTo-Json -Compress))
  Move-Item -LiteralPath $temporary -Destination $resultPath -Force
}

function Request-ScannerStop {
  if ($scannerProcess -and -not $scannerProcess.HasExited) {
    [ScannerConsole]::Close([uint32]$scannerProcess.Id) | Out-Null
  }
}

try {
  if (-not $Elevated) {
    function Quote-Literal([string]$value) { "'" + $value.Replace("'", "''") + "'" }
    $invocation = '& ' + (Quote-Literal $PSCommandPath) + ' -Elevated' +
      ' -JobDirectory ' + (Quote-Literal $JobDirectory) +
      ' -ExecutablePath ' + (Quote-Literal $ExecutablePath) +
      ' -ExpectedHash ' + (Quote-Literal $ExpectedHash) +
      ' -OwnerPid ' + $OwnerPid + ' -TimeoutSeconds ' + $TimeoutSeconds
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($invocation))
    $helper = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WindowStyle Hidden -PassThru -Wait `
      -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
    if (-not (Test-Path -LiteralPath $resultPath)) { throw "Scanner helper exited without a result (exit $($helper.ExitCode))" }
    exit
  }

  $ownerStarted = (Get-Process -Id $OwnerPid).StartTime.Ticks
  if (Test-Path -LiteralPath $cancelPath) {
    Write-Result @{ status = 'cancelled' }
    exit
  }
  $mutex = New-Object System.Threading.Mutex($false, 'Local\HsrOptimizerScanner')
  try { $ownsMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) { throw 'Another optimizer scanner is already running' }
  Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class ScannerConsole {
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint id);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList(uint[] list, uint size);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int show);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  public static bool Close(uint id) {
    FreeConsole();
    if (!AttachConsole(id)) return false;
    IntPtr window = IntPtr.Zero;
    bool owned = false;
    try {
      uint[] members = new uint[3];
      uint count = GetConsoleProcessList(members, 3);
      owned = count > 0 && count <= 2;
      for (int i = 0; i < Math.Min(count, 3); i++)
        owned &= members[i] == id || members[i] == (uint)Process.GetCurrentProcess().Id;
      window = GetConsoleWindow();
      if (owned) ShowWindow(window, 0);
    } finally { FreeConsole(); }
    return owned && window != IntPtr.Zero && PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
  }
}
'@
  $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
  $executableStream = [IO.File]::OpenRead($ExecutablePath)
  try { $actualHash = [BitConverter]::ToString($hashAlgorithm.ComputeHash($executableStream)).Replace('-', '') }
  finally { $executableStream.Dispose(); $hashAlgorithm.Dispose() }
  if ($actualHash -ne $ExpectedHash) { throw 'Scanner SHA-256 verification failed' }

  $output = Join-Path $JobDirectory 'scan.json'
  $captureLog = Join-Path $JobDirectory 'capture.log'
  $env:RUST_LOG = 'reliquary_archiver=info,pktmon=info'
  # The headless scanner allocates its own hidden console. A console-close event
  # invokes PacketMonitor's cleanup hook; force-killing skips that cleanup.
  [ScannerConsole]::FreeConsole() | Out-Null
  $scannerProcess = Start-Process -FilePath $ExecutablePath -WindowStyle Hidden -PassThru -WorkingDirectory $JobDirectory `
    -RedirectStandardOutput $captureLog -RedirectStandardError (Join-Path $JobDirectory 'stderr.log') `
    -ArgumentList @('--headless', '--no-update', '--exit-after-capture', '--timeout', $TimeoutSeconds, ('"' + $output + '"'))
  $null = $scannerProcess.Handle
  $ready = $false
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds + 30)
  while (-not $scannerProcess.WaitForExit(500)) {
    if (-not $ready -and (Select-String -LiteralPath $captureLog -SimpleMatch 'Capture started' -Quiet)) {
      [IO.File]::WriteAllText((Join-Path $JobDirectory 'running'), 'running')
      $ready = $true
    }
    $owner = Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue
    if ((Test-Path -LiteralPath $cancelPath) -or -not $owner -or $owner.StartTime.Ticks -ne $ownerStarted) {
      if (-not $stopRequested) { Request-ScannerStop; $stopRequested = $true }
    }
    if ([DateTime]::UtcNow -gt $deadline) {
      Request-ScannerStop
      if (-not $scannerProcess.WaitForExit(10000)) { throw 'Scanner failed to exit after timeout and console close; process cleanup could not be confirmed' }
      throw 'Scanner exceeded its capture timeout'
    }
  }
  if ($stopRequested) { Write-Result @{ status = 'cancelled' }; exit }
  if ($scannerProcess.ExitCode -ne 0) { throw "Scanner exited with code $($scannerProcess.ExitCode)" }
  if (-not (Test-Path -LiteralPath $output)) { throw 'No inventory was captured. Start the scanner before entering the game, then click to enter before timeout.' }
  if (-not (Select-String -LiteralPath $captureLog -SimpleMatch 'retrieved all relevant packets, stop listening' -Quiet)) {
    throw 'Capture did not confirm a complete inventory. Output is retained for inspection but will not be imported.'
  }
  Write-Result @{ status = 'captured' }
} catch {
  Write-Result @{ status = 'failed'; error = $_.Exception.Message }
} finally {
  if ($scannerProcess -and -not $scannerProcess.HasExited) {
    Request-ScannerStop
    $null = $scannerProcess.WaitForExit(($TimeoutSeconds + 30) * 1000)
  }
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  if ($mutex) { $mutex.Dispose() }
}
