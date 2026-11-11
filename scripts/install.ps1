# Hornhoof installer for Windows.
#
#   powershell -ExecutionPolicy Bypass -c "& ([scriptblock]::Create((irm <server>/install.ps1))) --join <code>"
#       connect this computer and start the nodes in the code
#   powershell -ExecutionPolicy Bypass -c "irm <server>/install.ps1 | iex"
#       update the nodes already on this computer
#
# The nodes run in Docker Desktop, so this checks it first: it says how to get Docker Desktop when it is missing, and
# starts it when it does not run. Then the very same install.sh the command on a Mac or Linux runs does the rest, in a
# container of the updater image of the server's build, which has bash, curl and the Docker command line and works with
# this computer's Docker through its socket, in this terminal, so a sign-in asks here. The words after the command go to
# install.sh as they are. The container sees nothing of Windows, so it gets from here what install.sh reads of the computer
# elsewhere: the key this computer goes by, kept in %USERPROFILE%\.hornhoof\machine as install.sh keeps it in
# ~/.hornhoof/machine, the computer's name, and its processor, cores and memory, which each node shows next to the share
# Docker gives it. They go through the environment, so no other program sees them on a command line.
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

  function Get-DockerText {
    $ErrorActionPreference = 'Continue'
    (& docker @args 2> $null | Out-String).Trim()
  }

  # Docker Desktop installed after this window opened is not on its PATH yet.
  function Find-Docker {
    if (Get-Command docker -ErrorAction SilentlyContinue) { return $true }
    if (-not $env:ProgramFiles) { return $false }
    $bin = [IO.Path]::Combine($env:ProgramFiles, 'Docker', 'Docker', 'resources', 'bin')
    if (-not (Test-Path ([IO.Path]::Combine($bin, 'docker.exe')))) { return $false }
    $env:Path = "$bin;$env:Path"
    $true
  }

  # Docker Desktop that is installed but not running starts like any app. It starts at sign-in only when its owner turns
  # that on, so the person hears how. The wait has no end of its own: the first start can ask things in its window.
  function Start-Docker {
    $app = $null
    if ($env:ProgramFiles) { $app = [IO.Path]::Combine($env:ProgramFiles, 'Docker', 'Docker', 'Docker Desktop.exe') }
    if ($app -and (Test-Path $app)) {
      Say 'Starting Docker Desktop. If it opens a window, answer it there; the first start can take a few minutes.'
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

  Say 'Checking Docker Desktop.'
  if (-not (Find-Docker)) {
    throw ("Hornhoof runs its nodes in Docker Desktop, which is not on this computer yet. To install it, run this in PowerShell:`n" +
      "  winget install -e --id Docker.DockerDesktop`n" +
      "or download it from https://www.docker.com/products/docker-desktop/ and open the file.`n" +
      'Windows may ask you to restart the computer. Then start Docker Desktop, accept its terms, and run this command again.')
  }
  if (-not (Test-Docker info)) { Start-Docker }
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
