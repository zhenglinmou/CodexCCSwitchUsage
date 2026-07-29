param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,
    [switch]$RuntimeOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') { throw 'ACL hardening is supported only on Windows.' }

$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if (-not $root -or [IO.Path]::GetPathRoot($root).TrimEnd('\') -eq $root) {
    throw "Refusing to harden an unsafe install root: $root"
}

$runtime = Join-Path $root 'runtime'
[IO.Directory]::CreateDirectory($root) | Out-Null
[IO.FileSystemInfo]$rootItem = Get-Item -LiteralPath $root -Force
if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to harden a reparse-point install root: $root"
}
[IO.Directory]::CreateDirectory($runtime) | Out-Null
[IO.FileSystemInfo]$runtimeItem = Get-Item -LiteralPath $runtime -Force
if ($runtimeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to harden a reparse-point runtime directory: $runtime"
}
$targetRoot = if ($RuntimeOnly) { $runtime } else { $root }
$targetPrefix = $targetRoot.TrimEnd('\') + '\'

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
if (-not $currentUser) { throw 'Unable to resolve the current Windows user SID.' }
$allowedSids = @(
    $currentUser,
    [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::LocalSystemSid, $null),
    [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
)

function Set-PrivateAcl {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][bool]$Directory
    )

    $fullPath = [IO.Path]::GetFullPath($LiteralPath)
    if ($fullPath -ne $targetRoot -and -not $fullPath.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to change ACL outside the selected root: $fullPath"
    }

    $item = if ($Directory) {
        [IO.DirectoryInfo]::new($fullPath)
    } else {
        [IO.FileInfo]::new($fullPath)
    }
    $existingAcl = if ($PSVersionTable.PSEdition -eq 'Core') {
        [IO.FileSystemAclExtensions]::GetAccessControl($item, [Security.AccessControl.AccessControlSections]::Owner)
    } else {
        $item.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner)
    }
    $existingOwner = $existingAcl.GetOwner([Security.Principal.SecurityIdentifier])

    $acl = if ($Directory) {
        New-Object Security.AccessControl.DirectorySecurity
    } else {
        New-Object Security.AccessControl.FileSecurity
    }
    if ($existingOwner.Value -ne $currentUser.Value) {
        $acl.SetOwner($currentUser)
    }
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = if ($Directory) {
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
        [Security.AccessControl.InheritanceFlags]::None
    }
    foreach ($sid in $allowedSids) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    if ($Directory) {
        if ($PSVersionTable.PSEdition -eq 'Core') {
            [IO.FileSystemAclExtensions]::SetAccessControl($item, $acl)
        } else {
            $item.SetAccessControl($acl)
        }
    } else {
        if ($PSVersionTable.PSEdition -eq 'Core') {
            [IO.FileSystemAclExtensions]::SetAccessControl($item, $acl)
        } else {
            $item.SetAccessControl($acl)
        }
    }
}

# Protect the root before walking existing children so another local user
# cannot add new inherited content while the tree is being hardened.
Set-PrivateAcl -LiteralPath $targetRoot -Directory $true
$children = @(Get-ChildItem -LiteralPath $targetRoot -Force -Recurse -ErrorAction Stop)
$reparsePoint = $children | Where-Object {
    $_.Attributes -band [IO.FileAttributes]::ReparsePoint
} | Select-Object -First 1
if ($reparsePoint) {
    throw "Refusing to harden a tree containing a reparse point: $($reparsePoint.FullName)"
}

$children = @($children | Sort-Object { $_.FullName.Length } -Descending)
foreach ($item in $children) {
    Set-PrivateAcl -LiteralPath $item.FullName -Directory ($item -is [IO.DirectoryInfo])
}
Set-PrivateAcl -LiteralPath $targetRoot -Directory $true
