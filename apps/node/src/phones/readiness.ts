import { PhoneReadinessIssue } from '@hornhoof/protocol';

const COMPLETE = 'ready-check-complete';

/* One ADB shell keeps a readback with its setting change. Only issue names go back to Hornhoof. */
export const readinessScript = String.raw`
check_setting() {
  if [ "$(settings --user current get "$1" "$2" 2>/dev/null)" = "$3" ]; then return; fi
  settings --user current put "$1" "$2" "$3" >/dev/null 2>&1
  [ "$(settings --user current get "$1" "$2" 2>/dev/null)" = "$3" ] || echo "$4"
}

check_setting global stay_on_while_plugged_in 7 awake
check_setting system screen_off_timeout 2147483647 awake
check_setting secure sleep_timeout -1 awake
check_setting secure attentive_timeout -1 awake
check_setting system screen_brightness_mode 0 brightness
check_setting system screen_brightness 128 brightness
check_setting secure reduce_bright_colors_activated 0 brightness
check_setting global low_power_sticky 0 batterySaver
check_setting global automatic_power_save_mode 0 batterySaver
check_setting global low_power_trigger_level 0 batterySaver
check_setting global adaptive_battery_management_enabled 0 appSleep
check_setting global app_standby_enabled 0 appSleep
check_setting global adb_allowed_connection_time 0 debugTrust

if [ "$(locksettings get-disabled 2>/dev/null)" != true ]; then
  locksettings set-disabled true >/dev/null 2>&1
fi
unlocked=$(locksettings get-disabled 2>/dev/null)
[ "$unlocked" = true ] || echo lock

idle_off() {
  [ "$(dumpsys deviceidle enabled deep 2>/dev/null)" = 0 ] && [ "$(dumpsys deviceidle enabled light 2>/dev/null)" = 0 ]
}
idle_off || dumpsys deviceidle disable >/dev/null 2>&1
idle_off || echo deviceIdle

power=$(dumpsys power 2>/dev/null)
if ! printf '%s\n' "$power" | grep -Eq 'mWakefulness=Awake|mWakefulnessRaw=Awake'; then
  input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
fi
if [ "$(settings get global low_power 2>/dev/null)" != 0 ]; then
  cmd power set-mode 0 >/dev/null 2>&1
fi
if ! printf '%s\n' "$power" | grep -Eq 'adaptive=false|mAdaptiveEnabled=false'; then
  cmd power set-adaptive-power-saver-enabled false >/dev/null 2>&1
fi
power=$(dumpsys power 2>/dev/null)
if [ "$(settings get global low_power 2>/dev/null)" != 0 ] || ! printf '%s\n' "$power" | grep -Eq 'adaptive=false|mAdaptiveEnabled=false'; then
  echo batterySaver
fi
if ! printf '%s\n' "$power" | grep -Eq 'mWakefulness=Awake|mWakefulnessRaw=Awake' || printf '%s\n' "$power" | grep -Eq 'mMaximumScreenOffTimeoutFromDeviceAdmin=.*enforced=true|mIsPowered=false'; then
  echo awake
fi

allowed_apps() {
  rows=$(dumpsys deviceidle whitelist 2>/dev/null) || return 1
  printf '%s\n' "$rows" | awk -F, '$1 == "user" || $1 == "system" { print $2 }'
}
exempt_apps() {
  apps=$(cmd package query-activities --components --user current -a android.intent.action.MAIN -c android.intent.category.LAUNCHER 2>/dev/null) || return 1
  packages=$(printf '%s\n' "$apps" | sed -n 's/^\([A-Za-z0-9_.][A-Za-z0-9_.]*\)\/[A-Za-z0-9_.$]*$/\1/p' | sort -u)
  [ -n "$packages" ] || return 1
  if pm path com.android.adbkeyboard 2>/dev/null | grep -q '^package:'; then packages="$packages com.android.adbkeyboard"; fi
  allowed=$(allowed_apps) || return 1
  set --
  for app in $packages; do
    if ! printf '%s\n' "$allowed" | grep -Fxq "$app"; then set -- "$@" "+$app"; fi
  done
  if [ "$#" -gt 0 ]; then dumpsys deviceidle whitelist "$@" >/dev/null 2>&1; fi
  allowed=$(allowed_apps) || return 1
  for app in $packages; do
    printf '%s\n' "$allowed" | grep -Fxq "$app" || return 1
  done
}
exempt_apps || echo appBattery

# Dismiss a swipe screen only when Android verified there is no secure lock.
if [ "$unlocked" = true ]; then wm dismiss-keyguard >/dev/null 2>&1; fi
focused_window() { dumpsys window 2>/dev/null | grep -m 1 'mCurrentFocus='; }
focus=$(focused_window)
case "$focus" in
  *NotificationShade*|*StatusBar*)
    cmd statusbar collapse >/dev/null 2>&1
    focus=$(focused_window)
    ;;
esac
case "$focus" in
  ''|*'=null'|*permissioncontroller*|*GrantPermissions*|*UsbDebugging*|*'Application Not Responding'*|*'Application Error'*|*'com.android.systemui/'*) echo prompt ;;
esac
echo ${COMPLETE}
`;

export function readReadiness(output: Buffer): PhoneReadinessIssue[] {
  const lines = new Set(output.toString().trim().split(/\r?\n/));
  if (!lines.has(COMPLETE)) return ['check'];
  return PhoneReadinessIssue.options.filter(issue => lines.has(issue));
}
