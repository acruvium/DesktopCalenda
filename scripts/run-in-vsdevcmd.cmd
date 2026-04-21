@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul
set "PATH=C:\Users\user\.cargo\bin;C:\Program Files\nodejs;%PATH%"
set "CARGO_HTTP_CHECK_REVOKE=false"
%*
