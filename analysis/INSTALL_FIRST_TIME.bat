@echo off
REM Double-click this file ONCE, the first time, to install the Python packages
REM the analysis needs. You only need to do this again if you move to a new
REM computer or reinstall Python.
cd /d "%~dp0"
echo Installing the Python packages the analysis needs...
echo (this can take a minute the first time)
echo.
py -m pip install -r requirements.txt
echo.
echo ============================================================
echo  Setup finished. You can close this window and then
echo  double-click RUN_ANALYSIS.bat to run the analysis.
echo ============================================================
echo.
pause
