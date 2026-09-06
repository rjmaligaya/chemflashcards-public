@echo off
REM Double-click this file to run all Section 4.2 analyses.
REM It runs run_all.py, which finds your data and writes the results folder.
cd /d "%~dp0"
py run_all.py
echo.
echo ============================================================
echo  Finished. Your results are in the "results" folder.
echo ============================================================
echo.
pause
