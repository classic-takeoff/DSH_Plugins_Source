param(
  [Parameter(Mandatory = $true)][string]$Payload,
  [switch]$Probe,
  [string]$Aumid = 'com.deepseek.dsh.notify'
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Write-Result([bool]$ok, [string]$setting, [string]$errorText) {
  $value = [ordered]@{ ok = $ok; setting = $setting }
  if (-not [string]::IsNullOrEmpty($errorText)) { $value.error = $errorText }
  [pscustomobject]$value | ConvertTo-Json -Compress
}

function Escape-Xml([string]$value) {
  if ($null -eq $value) { return '' }
  return [System.Security.SecurityElement]::Escape($value)
}

$setting = ''
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid)
  # A desktop AUMID that has never shown a toast can report a null Setting;
  # the value becomes Enabled after the first accepted Show.
  $rawSetting = $notifier.Setting
  $setting = if ($null -eq $rawSetting) { '' } else { $rawSetting.ToString() }

  if ($Probe) {
    Write-Result $true ($(if ($setting) { $setting } else { 'Unknown' })) ''
    exit 0
  }

  if ($setting -and $setting -ne 'Enabled') {
    Write-Result $false $setting "Windows notifications are $setting"
    exit 1
  }

  $json = [System.IO.File]::ReadAllText($Payload, [System.Text.Encoding]::UTF8)
  $p = $json | ConvertFrom-Json

  $token = [string]$p.token
  if ($token -notmatch '^[A-Za-z0-9_-]{16,128}$') { throw 'invalid notification token' }

  $title = [string]$p.title
  if ([string]::IsNullOrWhiteSpace($title)) { $title = '任务完成' }
  $summary = [string]$p.summary
  if ([string]::IsNullOrWhiteSpace($summary)) { $summary = '任务已完成，点击查看会话。' }
  $placeholder = [string]$p.placeholder
  if ([string]::IsNullOrWhiteSpace($placeholder)) { $placeholder = '输入回复…' }
  $replyLabel = [string]$p.replyLabel
  if ([string]::IsNullOrWhiteSpace($replyLabel)) { $replyLabel = '回复' }

  $icon = ''
  if (-not [string]::IsNullOrWhiteSpace([string]$p.iconPath) -and (Test-Path -LiteralPath ([string]$p.iconPath))) {
    $icon = [System.Uri]::new([string]$p.iconPath).AbsoluteUri
  }

  # Sound: `default` omits the audio element so Windows plays the user's
  # configured notification sound; `none` mutes; the remaining names select a
  # Windows notification sound event, exactly like the per-app sound picker.
  $sound = ([string]$p.sound).Trim().ToLowerInvariant()
  $audioTag = ''
  if ([string]::IsNullOrEmpty($sound)) {
    if ($p.silent -eq $true) { $audioTag = '<audio silent="true" />' }
  } elseif ($sound -eq 'none') {
    $audioTag = '<audio silent="true" />'
  } elseif ($sound -ne 'default') {
    $event = switch ($sound) {
      'im'       { 'Notification.IM' }
      'mail'     { 'Notification.Mail' }
      'reminder' { 'Notification.Reminder' }
      'sms'      { 'Notification.SMS' }
      'generic'  { 'Notification.Default' }
      default    { '' }
    }
    if ($event) { $audioTag = "<audio src=`"ms-winsoundevent:$event`" />" }
  }

  $xml = @"
<toast activationType="foreground" launch="open:$token" duration="long">
  <visual>
    <binding template="ToastGeneric">
      <text>$(Escape-Xml $title)</text>
      <text>$(Escape-Xml $summary)</text>
$(if ($icon) { "      <image placement=`"appLogoOverride`" src=`"$(Escape-Xml $icon)`" />" })
    </binding>
  </visual>
  <actions>
    <input id="reply" type="text" placeHolderContent="$(Escape-Xml $placeholder)" />
    <action content="$(Escape-Xml $replyLabel)" activationType="foreground" arguments="reply:$token" hint-inputId="reply" />
  </actions>
$(if ($audioTag) { "  $audioTag" })
</toast>
"@

  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
  $toast.Tag = $token
  $toast.Group = 'dsh'
  $notifier.Show($toast)
  $rawSetting = $notifier.Setting
  if ($null -ne $rawSetting) { $setting = $rawSetting.ToString() }
  if ([string]::IsNullOrEmpty($setting)) { $setting = 'Unknown' }
  Write-Result $true $setting ''
  exit 0
}
catch {
  $message = $_.Exception.Message
  if ([string]::IsNullOrEmpty($message)) { $message = 'toast notification failed' }
  Write-Result $false $setting $message
  exit 1
}
