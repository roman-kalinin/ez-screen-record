<#
.SYNOPSIS
    Drive the app through UI Automation, so features are exercised the way a
    user exercises them.

.DESCRIPTION
    Written because "it builds" and "it launched" are not evidence that a
    feature works. This clicks real buttons in the real window.

.PARAMETER Click
    AutomationId or Name of an element to invoke.

.PARAMETER List
    Dump the automation tree instead of clicking, to find element names.
#>
[CmdletBinding()]
param(
    [string]$Click,
    [switch]$List,
    [string]$Process = 'EzScreenRecord'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$proc = Get-Process -Name $Process -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw "No running '$Process' with a window" }

$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)

if ($List) {
    $all = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($e in $all) {
        $name = $e.Current.Name
        $type = $e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
        $id = $e.Current.AutomationId
        if ($name -or $id) { "{0,-22} {1,-16} {2}" -f $type, $id, $name }
    }
    return
}

if (-not $Click) { throw "Pass -Click <name> or -List" }

# Try AutomationId first, then Name: ids are stable, names are what a human sees.
foreach ($prop in @(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    [System.Windows.Automation.AutomationElement]::NameProperty)) {

    $cond = New-Object System.Windows.Automation.PropertyCondition($prop, $Click)
    $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($el) {
        $pattern = $null
        if ($el.TryGetCurrentPattern(
                [System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
            $pattern.Invoke()
            "invoked: $Click"
            return
        }
        if ($el.TryGetCurrentPattern(
                [System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
            $pattern.Toggle()
            "toggled: $Click"
            return
        }
        # Tabs and list items: SelectorBarItem exposes SelectionItem, not Invoke.
        if ($el.TryGetCurrentPattern(
                [System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
            $pattern.Select()
            "selected: $Click"
            return
        }
        throw "Found '$Click' but it supports none of Invoke, Toggle, SelectionItem"
    }
}

throw "No element named '$Click'"
