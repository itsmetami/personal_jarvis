$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$model = if ($env:JARVIS_MODEL) { $env:JARVIS_MODEL } else { 'qwen3.5:2b-q4_K_M' }
$tools = Join-Path (Split-Path $repo -Parent) 'tools'
$bundledNodeDir = Join-Path $tools 'node-v24.22.3-win-x64'
$bundledOllama = Join-Path $tools 'ollama\ollama.exe'
$node = if (Test-Path (Join-Path $bundledNodeDir 'node.exe')) {
    Join-Path $bundledNodeDir 'node.exe'
} else {
    (Get-Command node.exe -ErrorAction SilentlyContinue).Source
}
$npmCli = if (Test-Path (Join-Path $bundledNodeDir 'node_modules\npm\bin\npm-cli.js')) {
    Join-Path $bundledNodeDir 'node_modules\npm\bin\npm-cli.js'
} else {
    $null
}
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
$ollama = if (Test-Path $bundledOllama) {
    $bundledOllama
} else {
    (Get-Command ollama.exe -ErrorAction SilentlyContinue).Source
}

if (-not $node -or (-not $npm -and -not $npmCli)) {
    throw 'Node.js 20 or newer is required. Install it from https://nodejs.org/ and reopen this launcher.'
}
$nodeVersion = (& $node --version).Trim().TrimStart('v')
if ([version]$nodeVersion -lt [version]'20.0') {
    throw "Node.js 20 or newer is required; found $nodeVersion."
}
if ($npmCli) { $env:PATH = "$bundledNodeDir;$env:PATH" }
if (-not $ollama) {
    throw 'Ollama is required. Install it from https://ollama.com/download/, then run this launcher again.'
}

$env:VITE_BACKEND = 'ollama'
$env:VITE_OLLAMA_BASE_URL = '/ollama'
$env:VITE_OLLAMA_MODEL = $model

Push-Location $repo
try {
    if (-not (Test-Path (Join-Path $repo 'node_modules\vite\bin\vite.js'))) {
        Write-Host 'Installing JARVIS dependencies for this computer...'
        if ($npmCli) { & $node $npmCli ci } else { & $npm ci }
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    }

    & $node (Join-Path $repo 'scripts\prepare-assets.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Preparing local web assets failed.' }

    $ollamaReady = $false
    try {
        Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 | Out-Null
        $ollamaReady = $true
    } catch {
        # Start a local Ollama process below.
    }

    $startedOllama = $null
    if (-not $ollamaReady) {
        $saved = @{}
        $keys = @('USERPROFILE', 'OLLAMA_MODELS', 'OLLAMA_HOST', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_CONTEXT_LENGTH', 'OLLAMA_NUM_PARALLEL', 'OLLAMA_NO_CLOUD')
        foreach ($key in $keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
        try {
            $env:OLLAMA_HOST = '127.0.0.1:11434'
            $env:OLLAMA_KEEP_ALIVE = '5m'
            $env:OLLAMA_CONTEXT_LENGTH = '4096'
            $env:OLLAMA_NUM_PARALLEL = '1'
            $env:OLLAMA_NO_CLOUD = '1'
            $startedOllama = Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden -PassThru
        } finally {
            foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
        }

        for ($i = 0; $i -lt 40; $i++) {
            try {
                Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 | Out-Null
                $ollamaReady = $true
                break
            } catch {
                Start-Sleep -Milliseconds 500
            }
        }
    }

    if (-not $ollamaReady) { throw 'Ollama did not start on localhost:11434.' }

    $tags = Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5
    if (-not ($tags.models | Where-Object { $_.name -eq $model })) {
        $answer = Read-Host "Model $model is missing (about 1.9 GB). Download it now? [y/N]"
        if ($answer -notmatch '^(y|yes)$') {
            throw "Model not installed. Download it with: ollama pull $model"
        }

        & $ollama pull $model
        if ($LASTEXITCODE -ne 0) { throw "Could not download $model." }
    }

    Write-Host "JARVIS is using local Ollama model $model. Keep this window open; press Ctrl+C to stop."
    if ($npmCli) { & $node $npmCli run dev @args } else { & $npm run dev @args }
    exit $LASTEXITCODE
} finally {
    Pop-Location
    if ($startedOllama -and -not $startedOllama.HasExited) {
        Stop-Process -Id $startedOllama.Id -Force -ErrorAction SilentlyContinue
    }
}
