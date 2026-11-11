# Hornhoof installer for Windows.
#
#   powershell -ExecutionPolicy Bypass -c "& ([scriptblock]::Create((irm <server>/install.ps1))) --join <code>"
#       connect this computer and start the nodes in the code
#   powershell -ExecutionPolicy Bypass -c "irm <server>/install.ps1 | iex"
#       update the nodes already on this computer
#
# The nodes run in Docker Desktop, so this checks it first: it installs Docker Desktop when it is missing, with WSL 2 it
# runs on when Windows lacks that, under the one prompt of Windows to allow changes; it has Windows run this command again
# after a restart those need; and it starts Docker Desktop when it does not run. Then the very same install.sh the command
# on a Mac or Linux runs does the rest, in a container of the updater image of the server's build, which has bash, curl and
# the Docker command line and works with this computer's Docker through its socket, in this terminal, so a sign-in asks
# here. The words after the command go to install.sh as they are. The container sees nothing of Windows, so it gets from
# here what install.sh reads of the computer elsewhere: the key this computer goes by, kept in
# %USERPROFILE%\.hornhoof\machine as install.sh keeps it in ~/.hornhoof/machine, the computer's name, and its processor,
# cores and memory, which each node shows next to the share Docker gives it. They go through the environment, so no other
# program sees them on a command line.
#
# The server fills in its own address and the updater image of its build when it serves this file. It runs in Windows
# PowerShell 5.1, which every Windows 10 and 11 has, and in PowerShell 7. A failure says why and stops; it ends with exit
# only a PowerShell started for this command, so a window someone pasted irm | iex into stays open.

function Install-Hornhoof([string[]]$Words) {
  $ErrorActionPreference = 'Stop'
  $server = '__HORNHOOF_SERVER__'
  $helper = '__HORNHOOF_UPDATER_IMAGE__'
  if ($helper -like '__HORNHOOF_*' -or $helper -eq 'local') { $helper = 'ghcr.io/invariant0x/hornhoof-updater:latest' }

  # What install.sh runs in the container: the key goes where it looks for it, and the script comes from the server, as with
  # curl on a Mac or Linux. It holds no double quotes, which Windows PowerShell 5.1 does not pass on to a program as they are.
  $inside = 'set -e; mkdir -p $HORNHOOF_HOME; printf %s $HORNHOOF_MACHINE > $HORNHOOF_HOME/machine; f=$(mktemp); ' +
    'curl -fsSL $HORNHOOF_SERVER/install.sh -o $f || { echo Could not download the installer from $HORNHOOF_SERVER. Check the connection, then run this command again. >&2; exit 1; }; ' +
    'exec bash $f $@'

  function Say([string]$Text) { Write-Host $Text }

  # Whether a docker command succeeds, with what it says dropped. Windows PowerShell turns what a program writes to its
  # error output into errors, which would stop this script, so here they do not.
  function Test-Docker {
    $ErrorActionPreference = 'Continue'
    & docker @args *> $null
    $LASTEXITCODE -eq 0
  }

  # The same for reg.exe, which reads and writes the registry.
  function Invoke-Reg {
    $ErrorActionPreference = 'Continue'
    & reg @args *> $null
    $LASTEXITCODE -eq 0
  }

  function Get-DockerText {
    $ErrorActionPreference = 'Continue'
    (& docker @args 2> $null | Out-String).Trim()
  }

  # Docker Desktop installed after this window opened is not on its PATH yet. PATH in capitals is the same name on Windows,
  # and the only one elsewhere.
  function Find-Docker {
    if (Get-Command docker -ErrorAction SilentlyContinue) { return $true }
    if (-not $env:ProgramFiles) { return $false }
    $bin = [IO.Path]::Combine($env:ProgramFiles, 'Docker', 'Docker', 'resources', 'bin')
    if (-not (Test-Path ([IO.Path]::Combine($bin, 'docker.exe')))) { return $false }
    $env:PATH = $bin + [IO.Path]::PathSeparator + $env:PATH
    $true
  }

  # What WSL 2 needs for Docker Desktop, which runs on it from version 2.1.5: installing when Windows has none of its own
  # yet, as then wsl.exe says no to --version, or an update. Nothing when it is ready, or when there is no wsl.exe to ask.
  function Get-WslStep {
    if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) { return }
    $ErrorActionPreference = 'Continue'
    # wsl.exe writes UTF-16 unless told otherwise, which PowerShell would not read as text.
    $before = $env:WSL_UTF8
    $env:WSL_UTF8 = '1'
    $text = (& wsl --version 2> $null | Out-String)
    $ready = $LASTEXITCODE -eq 0
    $env:WSL_UTF8 = $before
    if (-not $ready) { return 'wsl --install --no-distribution' }
    if ($text -match '\d+\.\d+\.\d+' -and [version]$Matches[0] -lt [version]'2.1.5') { return 'wsl --update' }
  }

  # How Docker Desktop installs, as Docker documents it: quietly, with its terms accepted now rather than at its first start,
  # on WSL 2. winget checks what it downloads. Without winget the installer comes from docker.com into $installer and runs
  # only when Docker signed it.
  function Get-DockerStep {
    $options = 'install --quiet --accept-license --backend=wsl-2'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      return "winget install -e --id Docker.DockerDesktop --source winget --accept-package-agreements --accept-source-agreements --silent --override '$options'"
    }
    $arch = 'amd64'
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
    $url = "https://desktop.docker.com/win/main/$arch/Docker%20Desktop%20Installer.exe"
    Say 'Downloading Docker Desktop from docker.com. This can take a few minutes.'
    # Windows PowerShell draws the progress of a download so often that it slows the download itself.
    $ProgressPreference = 'SilentlyContinue'
    try {
      Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing
    } catch {
      Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
      throw "Could not download Docker Desktop from $url. Check the internet connection, then run this command again."
    }
    $signed = Get-AuthenticodeSignature -FilePath $installer
    if ($signed.Status -ne 'Valid' -or $signed.SignerCertificate.Subject -notmatch '(^|, )O="?Docker,? Inc') {
      Remove-Item -LiteralPath $installer -Force
      throw 'The Docker Desktop installer that came from docker.com is not signed by Docker, so it did not run. Run this command again.'
    }
    $quoted = $installer -replace "'", "''"
    $arguments = ($options.Split(' ') | ForEach-Object { "'$_'" }) -join ', '
    # The installer is a window program, which PowerShell does not wait for unless told to.
    "`$LASTEXITCODE = (Start-Process -FilePath '$quoted' -Wait -PassThru -ArgumentList $arguments).ExitCode"
  }

  # What needs an administrator runs in one more Windows PowerShell, which Windows asks the person about once. Its steps run
  # in turn, and it ends with the number of the step that failed, a program that is not there failing too, or with 100 when
  # a step said a restart finishes its work, as Windows installers say with 3010.
  function Invoke-AsAdmin([string[]]$Steps) {
    $lines = @('$restart = $false')
    $n = 0
    foreach ($step in $Steps) {
      $n++
      $lines += "`$LASTEXITCODE = 1; $step; if (`$LASTEXITCODE -eq 3010) { `$restart = `$true } elseif (`$LASTEXITCODE -ne 0) { exit $n }"
    }
    $lines += 'if ($restart) { exit 100 }', 'exit 0'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($lines -join "`n"))
    try {
      $done = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded
    } catch {
      throw 'Windows did not get a Yes to allow the changes, so nothing was installed. Run this command again and choose Yes when Windows asks.'
    }
    $done.ExitCode
  }

  # Whether Windows waits for a restart to finish what was installed, as it notes when WSL turns on a part of Windows.
  function Test-Restart { Invoke-Reg query 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending' /reg:64 }

  # After the restart Windows runs this command again once the person signs in, from RunOnce in their own part of the
  # registry, and deletes the value before it runs it. Until then the value holds the join code, which is acceptable: the
  # code works once and for 24 hours, and this part of the registry is this person's, which other people on the computer
  # do not read. A code that expired meanwhile gets the server's answer, which says to get a new command. The command waits
  # for the network, which may come a moment after sign-in. Windows runs at most 260 characters from there, so words that
  # would not fit, or not come back the same, are not written.
  function Set-RunOnce([string[]]$Words) {
    $line = "powershell -NoExit -ExecutionPolicy Bypass -c for(;;){try{`$s=irm $server/install.ps1;break}catch{'Waiting for the network.';sleep 2}};&([scriptblock]::Create(`$s))"
    if ($Words) { $line += ' ' + ($Words -join ' ') }
    if ($line.Length -gt 260 -or $server -notmatch '^https?://[A-Za-z0-9.:/_-]+$' -or ($Words | Where-Object { $_ -notmatch '^[A-Za-z0-9_=.-]+$' })) { return $false }
    Invoke-Reg add $runOnce /v Hornhoof /t REG_SZ /d $line /f
  }

  # Docker Desktop that is installed but not running starts like any app. It starts at sign-in only when its owner turns
  # that on, so the person hears how. The wait has no end of its own: the first start can ask things in its window.
  function Start-Docker {
    $app = $null
    if ($env:ProgramFiles) { $app = [IO.Path]::Combine($env:ProgramFiles, 'Docker', 'Docker', 'Docker Desktop.exe') }
    if ($app -and (Test-Path $app)) {
      Say 'Starting Docker Desktop. The first start can take a few minutes. If it shows its terms, accept them; Hornhoof needs no Docker account, so there is no need to sign in to Docker.'
      Say 'So Hornhoof comes back after a restart, turn on Start Docker Desktop when you sign in to your computer, under Settings, General in Docker Desktop.'
      Start-Process -FilePath $app
    } else {
      Say 'Docker is installed but not running. Start Docker Desktop from the Start menu.'
    }
    Say 'Waiting for Docker to start. To stop waiting, press Ctrl+C.'
    $looks = 0
    while (-not (Test-Docker info)) {
      Start-Sleep -Seconds 2
      $looks++
      if ($looks % 30 -eq 0) { Say 'Still waiting for Docker to start. If Docker Desktop shows a window or a message, answer it there.' }
    }
  }

  # The key this computer goes by: made once, 32 hex digits as install.sh makes it, and kept.
  function Get-MachineKey {
    $dir = Join-Path $HOME '.hornhoof'
    $file = Join-Path $dir 'machine'
    if (Test-Path $file) {
      $key = ([IO.File]::ReadAllText($file)).Trim()
      if ($key -cmatch '^[0-9a-f]{32}$') { return $key }
    }
    $bytes = New-Object byte[] 16
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $key = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    [IO.File]::WriteAllText($file, $key)
    $key
  }

  # The computer's name as Hornhoof lists it, in the letters a container's name may have.
  function Get-ComputerName {
    $name = $env:COMPUTERNAME
    try { $name = [Net.Dns]::GetHostName() } catch { }
    $name = ([string]$name -replace '[^A-Za-z0-9.-]', '').Trim('.-')
    if ($name.Length -gt 63) { $name = $name.Substring(0, 63).Trim('.-') }
    if (-not $name) { $name = 'windows' }
    $name
  }

  # What Windows says it has, in the words install.sh hands on to each node. What it cannot read is left out.
  function Get-HostFacts {
    $facts = @{}
    if ([Environment]::ProcessorCount -gt 0) { $facts['HORNHOOF_HOST_CPUS'] = [string][Environment]::ProcessorCount }
    try {
      $cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
      $cpu = (([string]$cpu -replace '[^A-Za-z0-9 ()@.,_-]', '') -replace ' +', ' ').Trim()
      if ($cpu.Length -gt 200) { $cpu = $cpu.Substring(0, 200).Trim() }
      if ($cpu) { $facts['HORNHOOF_HOST_CPU'] = $cpu }
      $memory = [uint64](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
      if ($memory -gt 0) { $facts['HORNHOOF_HOST_MEMORY'] = [string]$memory }
    } catch { }
    $facts
  }

  if (-not $server -or $server -like '__HORNHOOF_*') { throw 'This installer does not know its Hornhoof server. Copy the command from Hornhoof again.' }
  if ($server -match '^https?://(localhost|127\.0\.0\.1)([:/]|$)') {
    throw "This Hornhoof runs on this computer at $server, an address Docker cannot reach. Run the command for a Mac or Linux in the Ubuntu terminal of WSL, where this Hornhoof runs."
  }

  $runOnce = 'HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce'
  Say 'Checking Docker Desktop.'
  $found = Find-Docker
  if (-not ($found -and (Test-Docker info))) {
    # Docker Desktop that is missing installs, after WSL 2 it runs on when that is not ready, and Docker Desktop that is
    # there but does not run gets WSL 2 the same way. Windows asks the person once for all of it.
    $steps = @()
    $wsl = Get-WslStep
    if ($wsl) {
      Say 'Turning on WSL 2 of Windows, which Docker Desktop runs on.'
      $steps += $wsl
    }
    $installer = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'Docker Desktop Installer.exe')
    if (-not $found) {
      Say 'Installing Docker Desktop, where Hornhoof runs its nodes. Docker Desktop has its own terms: free for personal use and small companies, see https://docs.docker.com/subscription/desktop-license/'
      $steps += Get-DockerStep
    }
    if ($steps) {
      Say 'Windows asks once to allow the changes: choose Yes.'
      try {
        $ended = Invoke-AsAdmin $steps
      } finally {
        if (-not $found) { Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }
      }
      if ($ended -eq 100 -or (Test-Restart)) {
        if (Set-RunOnce $Words) {
          Say 'Windows needs a restart to finish installing. Restart the computer; when you sign in again, Hornhoof goes on by itself in a PowerShell window.'
        } else {
          Say 'Windows needs a restart to finish installing. Restart the computer, then run this command again.'
        }
        # The programs above ended as they did; this command ends well.
        $global:LASTEXITCODE = 0
        return
      }
      if ($wsl -and $ended -eq 1) { throw 'Windows could not turn on WSL 2, which Docker Desktop needs. Check the internet connection, then run this command again.' }
      # Docker documents no ends of its installer, so whether it installed is what is there now.
      if (-not (Find-Docker)) { throw 'Docker Desktop did not install. Check the internet connection, then run this command again.' }
    }
    Start-Docker
  }
  if ((Get-DockerText info --format '{{.OSType}}') -eq 'windows') {
    throw 'Docker Desktop runs Windows containers now, and Hornhoof needs Linux containers. Right-click the Docker icon next to the clock, choose Switch to Linux containers, then run this command again.'
  }

  Say "Getting the Hornhoof installer image $helper."
  if (-not (Test-Docker pull $helper) -and -not (Test-Docker image inspect $helper)) {
    throw "Could not download $helper. Check the internet connection, then run this command again."
  }

  $passed = Get-HostFacts
  $passed['HORNHOOF_SERVER'] = $server
  $passed['HORNHOOF_HOME'] = '/hornhoof'
  $passed['HORNHOOF_MACHINE'] = Get-MachineKey
  # A terminal that is not a console, as the PowerShell ISE, gets no sign-in here: install.sh then says how to sign in.
  $run = @('run', '--rm', '-i')
  if (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) { $run += '-t' }
  $run += @('--hostname', (Get-ComputerName), '-v', '//var/run/docker.sock:/var/run/docker.sock')
  foreach ($name in $passed.Keys) { $run += @('-e', $name) }
  $run += @('--entrypoint', 'sh', $helper, '-c', $inside, 'install')
  if ($Words) { $run += $Words }
  $before = @{}
  foreach ($name in $passed.Keys) {
    $before[$name] = [Environment]::GetEnvironmentVariable($name)
    [Environment]::SetEnvironmentVariable($name, [string]$passed[$name])
  }
  # A command waiting in RunOnce for a restart would only do again what this one does now, with a code used up.
  $null = Invoke-Reg delete $runOnce /v Hornhoof /f
  # install.sh says why it stops on its error output, which is no error of this script.
  $ErrorActionPreference = 'Continue'
  try {
    & docker @run
  } finally {
    foreach ($name in $before.Keys) { [Environment]::SetEnvironmentVariable($name, $before[$name]) }
  }
}

$hornhoofFailed = $false
try {
  Install-Hornhoof $args
  # install.sh said what went wrong itself.
  $hornhoofFailed = $LASTEXITCODE -ne 0
} catch {
  Write-Host $_.Exception.Message
  $hornhoofFailed = $true
}
$hornhoofLaunch = [Environment]::GetCommandLineArgs()
if ($hornhoofFailed -and ($hornhoofLaunch -contains '-c' -or $hornhoofLaunch -contains '-Command') -and $hornhoofLaunch -notcontains '-NoExit') { exit 1 }
