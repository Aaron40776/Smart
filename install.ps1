# Installs smart on Windows 10/11, or updates it when it is already installed. In PowerShell:
#
#   irm https://raw.githubusercontent.com/Aaron40776/Smart/main/install.ps1 | iex
#
# To read it before it runs (recommended):
#
#   irm https://raw.githubusercontent.com/Aaron40776/Smart/main/install.ps1 -OutFile install.ps1; notepad install.ps1; .\install.ps1
#
# Options, as environment variables (all optional):
#   SMART_DIR     where to install (default %USERPROFILE%\Smart)
#   SMART_REF     a tag, branch or commit to install instead of the latest main. A tag or commit pins the installation:
#                 `smart update` then leaves it alone until you run this again with another SMART_REF.
#   SMART_COMMIT  the full commit id you expect. If the code is not exactly that commit, nothing from it is run.
#   SMART_REPO    install from another clone URL or folder (a fork, or CI testing a change)
#
# It never discards your work: a folder with local changes, or a clone of another repository, is left as it is.
# Dependencies are installed with `npm ci --ignore-scripts`: exactly what package-lock.json lists (npm checks every
# package's integrity hash), and no package's own install scripts run.
# Everything runs in a script block that returns on failure: `exit` would close your PowerShell window under `iex`.
& {
    # Native commands report failure through $LASTEXITCODE; 'Stop' would also turn git's progress output into errors.
    $ErrorActionPreference = 'Continue'
    $repo = if ($env:SMART_REPO) { $env:SMART_REPO } else { 'https://github.com/Aaron40776/Smart.git' }
    $dir = if ($env:SMART_DIR) { $env:SMART_DIR } else { Join-Path $env:USERPROFILE 'Smart' }
    $ref = $env:SMART_REF
    $expected = if ($env:SMART_COMMIT) { $env:SMART_COMMIT.Trim().ToLowerInvariant() } else { '' }

    function Say([string]$text, [string]$color = 'Gray') { Write-Host "smart: $text" -ForegroundColor $color }
    # Two spellings of one repository compare equal: https or ssh, with or without .git, any case.
    function Norm([string]$url) {
        if (-not $url) { return '' }
        $u = $url.Trim() -replace '^git@github\.com:', 'https://github.com/' -replace '\.git$', '' -replace '[\\/]+$', ''
        return $u.ToLowerInvariant()
    }

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Say 'Git is needed: install it from https://git-scm.com/download/win, then open a new terminal and run this again.' Red
        return
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Say 'Node.js 22 or newer is needed: install it from https://nodejs.org, then open a new terminal and run this again.' Red
        return
    }
    $major = [int](((node --version) -replace '^v', '').Split('.')[0])
    if ($major -lt 22) {
        Say "Node.js 22 or newer is needed (you have $(node --version)): update it from https://nodejs.org." Red
        return
    }
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        Say 'Note: the Claude Code CLI (claude) was not found. Install it and run `claude` once to log in before using smart.' Yellow
    }

    if (Test-Path (Join-Path $dir '.git')) {
        # Only a clone of the expected repository is updated: never pull someone else's code into it, or ours into theirs.
        $origin = git -C $dir remote get-url origin 2>$null
        if ($LASTEXITCODE -ne 0 -or (Norm $origin) -ne (Norm $repo)) {
            Say "$dir is a git clone of '$origin', not of $repo, so it is left as it is. Set `$env:SMART_DIR to another folder." Red
            return
        }
        # Your changes are never discarded: stop and say what is changed.
        $dirty = git -C $dir status --porcelain --untracked-files=no
        if ($LASTEXITCODE -ne 0) {
            Say "git status failed in $dir (see above); nothing was changed." Red
            return
        }
        if ($dirty) {
            Say "Nothing was changed: files in $dir have local changes:" Red
            $dirty | ForEach-Object { Say "  $_" Red }
            Say "Commit them, or set them aside with: git -C `"$dir`" stash   (git stash pop brings them back). Then run this again." Yellow
            return
        }
        Say "Updating $dir"
        git -C $dir fetch --tags --quiet origin
        if ($LASTEXITCODE -ne 0) {
            Say 'Getting the code failed (see above); nothing was changed. Check your internet connection.' Red
            return
        }
        if ($ref) {
            git -C $dir checkout --quiet $ref
        } else {
            git -C $dir symbolic-ref -q --short HEAD *> $null
            if ($LASTEXITCODE -ne 0) {
                Say "$dir is pinned to a fixed version (no branch is checked out), so it is left as it is. Set `$env:SMART_REF to the version you want and run this again." Yellow
                return
            }
            # Fast-forward only: local commits are kept, and a branch that has diverged is reported instead of rewritten.
            git -C $dir merge --ff-only --quiet '@{u}'
        }
    } elseif ((Test-Path $dir) -and (Get-ChildItem -Force $dir | Select-Object -First 1)) {
        Say "$dir exists and is not a smart installation, so it is left as it is. Set `$env:SMART_DIR to another folder." Red
        return
    } else {
        Say "Downloading into $dir"
        git clone --quiet $repo $dir
        if ($LASTEXITCODE -eq 0 -and $ref) { git -C $dir checkout --quiet $ref }
    }
    if ($LASTEXITCODE -ne 0) {
        Say 'Getting the code failed (see above). Nothing was built or run.' Red
        return
    }

    $head = (git -C $dir rev-parse HEAD).Trim()
    if ($expected -and $head -ne $expected) {
        Say "The code is at commit $head, not the expected $expected. Stopping before anything from it runs." Red
        return
    }

    Push-Location $dir
    try {
        # npm.cmd, not npm: the npm.ps1 shim is blocked where scripts are disabled. `ci` installs exactly what
        # package-lock.json says and never rewrites it, so the next update is not blocked by a changed lockfile.
        foreach ($step in @(@('ci', '--ignore-scripts'), @('run', 'build'), @('link'))) {
            Say "npm $($step -join ' ')"
            & npm.cmd @step
            if ($LASTEXITCODE -ne 0) {
                Say "npm $($step -join ' ') failed (see above). The code is at commit $head; run this again once the problem is fixed." Red
                return
            }
        }
    } finally {
        Pop-Location
    }
    $version = (Get-Content -Raw (Join-Path $dir 'package.json') | ConvertFrom-Json).version
    Say "Done: smart $version (commit $head). Open a new terminal and run: smart   (later updates: smart update)" Green
}
