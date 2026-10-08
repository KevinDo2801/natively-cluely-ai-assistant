import { execFile } from 'child_process';

function runPowerShell(script: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024,
    }, (error, stdout) => resolve({ ok: !error, output: String(stdout || '').trim() }));
  });
}

const PREAMBLE = `Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$m = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])`;

export class DictateMediaController {
  private pausedApps: string[] = [];

  public async pausePlaying(): Promise<boolean> {
    this.pausedApps = [];
    if (process.platform !== 'win32') return false;
    const result = await runPowerShell(`try {
${PREAMBLE}
$paused = @()
foreach ($s in $m.GetSessions()) {
  try {
    if ($s.GetPlaybackInfo().PlaybackStatus -eq 4) {
      if (Await ($s.TryPauseAsync()) ([bool])) { $paused += $s.SourceAppUserModelId }
    }
  } catch { continue }
}
$paused -join '|'
} catch { Write-Output 'GSMTC_FAIL' }`);
    if (!result.ok || result.output === 'GSMTC_FAIL') return false;
    this.pausedApps = result.output.split('|').filter(Boolean);
    return this.pausedApps.length > 0;
  }

  public async resumePaused(): Promise<boolean> {
    const apps = this.pausedApps;
    this.pausedApps = [];
    if (process.platform !== 'win32' || apps.length === 0) return false;
    const ids = apps.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
    const result = await runPowerShell(`try {
${PREAMBLE}
$ids = @(${ids})
foreach ($s in $m.GetSessions()) {
  try { if ($ids -contains $s.SourceAppUserModelId) { $null = Await ($s.TryPlayAsync()) ([bool]) } } catch { continue }
}
Write-Output 'OK'
} catch { Write-Output 'GSMTC_FAIL' }`);
    return result.ok && result.output === 'OK';
  }
}
