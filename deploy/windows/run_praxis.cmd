@echo off
rem Praxis cards API launcher (Windows). Output discarded to mirror the VPS no-logs design.
rem
rem Bind to the Tailscale address ONLY. Not 0.0.0.0: the Windows firewall is
rem disabled on this machine, so a wildcard bind would expose the API to the
rem whole home network. Binding to the tailnet interface is the filter.
rem
rem If Tailscale is not up yet at boot the bind fails; the scheduled task
rem retries every minute, so the service comes up once the tunnel is ready.
set CORPUS_DB=C:/praxis/praxis.db
set LAW_DB=C:/praxis/praxis.db
set PRAXIS_TOKEN=…спільний ключ вітрини…
set PRAXIS_WORKERS=4
"C:\Users\Aleksandr\AppData\Local\Programs\Python\Python311\python.exe" "C:\praxis\cards_api.py" --serve --host 100.70.93.113 --port 8788 >nul 2>&1
