# Starts the VeriPura platform project from its memory: opens Claude in this folder and runs the
# /pickup routine, which reads the project memory, checks git and the sandbox, runs the tests,
# and reports where things stand.
#
# Usage:   .\resume.ps1
# From anywhere, if the `veripura` command is installed in your PowerShell profile: veripura
Set-Location -LiteralPath $PSScriptRoot
claude "/pickup"
