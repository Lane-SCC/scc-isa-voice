$path = "c:/Users/lanes/OneDrive/Desktop/LFG/scenarios.json"
$bak = "$path.bak"
Copy-Item -Path $path -Destination $bak -Force
$content = Get-Content -Path $path -Raw
$json = $content | ConvertFrom-Json
$mapping = @{
    "confirm permission to ask questions" = "confirm_permission"
    "confirm best callback number" = "confirm_callback_number"
    "set follow-up time" = "set_follow_up_time"
    "capture timeline" = "capture_timeline"
    "attempt application" = "attempt_application"
    "explain current stage" = "explain_current_stage"
    "identify next action" = "identify_next_action"
    "restate boundaries" = "restate_boundaries"
    "clarify status" = "clarify_status"
    "set expectations" = "set_expectations"
    "acknowledge concern" = "acknowledge_concern"
    "set update cadence" = "set_update_cadence"
    "maintain boundary" = "maintain_boundary"
    "define next step" = "define_next_step"
    "define review step" = "define_review_step"
}
function Normalize($node) {
    if ($null -eq $node) { return }
    if ($node -is [System.Management.Automation.PSCustomObject] -or $node -is [System.Collections.Hashtable]) {
        foreach ($prop in $node.psobject.properties) {
            if ($prop.Name -eq 'mustHit' -and $prop.Value -is [System.Collections.IEnumerable]) {
                $new = @()
                foreach ($item in $prop.Value) {
                    $key = $item.ToString().ToLower()
                    if ($mapping.ContainsKey($key)) { $new += $mapping[$key] } else { $new += $item }
                }
                $node.mustHit = $new
            } else {
                Normalize($prop.Value)
            }
        }
    } elseif ($node -is [System.Collections.IEnumerable]) {
        foreach ($el in $node) { Normalize($el) }
    }
}
Normalize($json)
$json | ConvertTo-Json -Depth 20 | Out-File -FilePath $path -Encoding UTF8
Write-Output "Normalization complete. Backup at: $bak"
