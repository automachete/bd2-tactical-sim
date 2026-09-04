[CmdletBinding()]
param(
    [ValidateSet("3.13", "3.14")]
    [string]$PythonVersion = "3.13",
    [switch]$Cuda
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepositoryRoot = $PSScriptRoot
$VirtualEnvironment = Join-Path $RepositoryRoot ".venv"
$Python = Join-Path $VirtualEnvironment "Scripts\python.exe"
$Catalog = Join-Path $RepositoryRoot "data\generated\catalog.json"
$EquipmentOracle = Join-Path $RepositoryRoot "data\generated\equipment-oracle.json"
$Database = Join-Path $RepositoryRoot "data\generated\bd2.sqlite"
$CargoManifest = Join-Path $RepositoryRoot "Cargo.toml"
$DataCli = Join-Path $RepositoryRoot "target\debug\bd2-data.exe"

function Invoke-Checked {
    param(
        [Parameter(Mandatory)]
        [string]$FilePath,
        [string[]]$ArgumentList = @()
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath"
    }
}

Write-Host "[1/5] Creating the Python environment"
Invoke-Checked -FilePath "py" -ArgumentList @("-$PythonVersion", "-m", "venv", $VirtualEnvironment)

$TorchChannel = if ($Cuda) { "cu130" } else { "cpu" }
Invoke-Checked -FilePath $Python -ArgumentList @(
    "-m", "pip", "install", "torch==2.13.0",
    "--index-url", "https://download.pytorch.org/whl/$TorchChannel"
)
Invoke-Checked -FilePath $Python -ArgumentList @(
    "-m", "pip", "install", "-e", "$($RepositoryRoot)[test]"
)

Write-Host "[2/5] Installing data-tool dependencies"
Invoke-Checked -FilePath "npm.cmd" -ArgumentList @(
    "--prefix", (Join-Path $RepositoryRoot "tools"), "ci", "--ignore-scripts"
)

Write-Host "[3/5] Synchronizing and validating game data"
Invoke-Checked -FilePath "node" -ArgumentList @(
    (Join-Path $RepositoryRoot "tools\sync-bd2db.mjs"),
    "--out", $Catalog,
    "--equipment-oracle", $EquipmentOracle
)
Invoke-Checked -FilePath "node" -ArgumentList @(
    (Join-Path $RepositoryRoot "tools\validate-catalog.mjs"), $Catalog
)
Invoke-Checked -FilePath "node" -ArgumentList @(
    (Join-Path $RepositoryRoot "tools\validate-bd2db-equipment.mjs"),
    $Catalog,
    $EquipmentOracle
)
Invoke-Checked -FilePath "node" -ArgumentList @(
    (Join-Path $RepositoryRoot "tools\build-current-scenarios.mjs"), "10072", "6"
)

Write-Host "[4/5] Building the local database"
Invoke-Checked -FilePath "cargo" -ArgumentList @(
    "build", "--manifest-path", $CargoManifest, "--target-dir", (Join-Path $RepositoryRoot "target"),
    "-p", "bd2-data", "--bin", "bd2-data"
)
Invoke-Checked -FilePath $DataCli -ArgumentList @("import-catalog", $Catalog, $Database)

$Scenarios = @(
    "normal-demo.json",
    "mirror-war-demo.json",
    "monster-chaser-current.json",
    "golden-colosseum-reference.json"
)
foreach ($Scenario in $Scenarios) {
    $ScenarioPath = Join-Path $RepositoryRoot "data\scenarios\$Scenario"
    Invoke-Checked -FilePath $DataCli -ArgumentList @("import-scenario", $ScenarioPath, $Database)
}
Invoke-Checked -FilePath $DataCli -ArgumentList @("inspect", $Database)

Write-Host "[5/5] Building the browser interface"
Invoke-Checked -FilePath "npm.cmd" -ArgumentList @(
    "--prefix", (Join-Path $RepositoryRoot "ui"), "ci"
)
Invoke-Checked -FilePath "npm.cmd" -ArgumentList @(
    "--prefix", (Join-Path $RepositoryRoot "ui"), "run", "build"
)

Write-Host "Setup complete. Start the simulator with .\.venv\Scripts\bd2-play.exe"
