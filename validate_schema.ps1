$path = 'c:\Users\lanes\OneDrive\Desktop\LFG\scenarios.json'
try {
    $json = Get-Content $path -Raw | ConvertFrom-Json
} catch {
    Write-Output "DATA_LOAD_ERROR: $($_.Exception.Message)"
    exit 2
}

$sections = @('mcd','m1','m2')
$reqProps = @('id','summary','objective','borrowerName','borrowerGender','borrowerStyle','emotionalBaseline','stallReason','ruleFocus','baitType','requiredOutcome','openers','mustHit','handoffForbiddenUntil','loEscalationScript')
$errors = @()

foreach ($s in $sections) {
    if (-not $json.PSObject.Properties.Name -contains $s) {
        $errors += "Missing top-level section: $s"
        continue
    }
    $sec = $json.$s
    foreach ($tier in @('Standard','Moderate','Edge')) {
        if (-not $sec.PSObject.Properties.Name -contains $tier) {
            $errors += "Missing tier '$tier' in section $s"
            continue
        }
        $arr = $sec.$tier
        if (-not ($arr -is [System.Array])) { $errors += "Tier $s.$tier is not an array"; continue }
        for ($i=0; $i -lt $arr.Count; $i++) {
            $item = $arr[$i]
            $prefix = "$s.$tier[$i]"
            foreach ($p in $reqProps) {
                if (-not $item.PSObject.Properties.Name -contains $p) {
                    $errors += "Missing property '$p' at $prefix"
                    continue
                }
                $val = $item.$p
                if ($p -in @('ruleFocus','openers','pressureLines','escalationLadder','mustHit')) {
                    if (-not ($val -is [System.Array])) { $errors += "Property '$p' at $prefix should be an array" }
                } else {
                    if (-not ($val -is [string])) { $errors += "Property '$p' at $prefix should be a string" }
                }
            }
            # check id uniqueness could be done later
        }
    }
}

if ($errors.Count -eq 0) { Write-Output "SCHEMA_VALID: lightweight structural checks passed."; exit 0 }
Write-Output "SCHEMA_INVALID: Found $($errors.Count) issue(s):"
$errors | ForEach-Object { Write-Output "- $_" }
exit 1

