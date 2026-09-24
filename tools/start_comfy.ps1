# ── 关键：强制 UTF-8，避免 emoji 在 GBK(936) 控制台/管道下触发 UnicodeEncodeError。
# 该错误会打死 ComfyUI 的执行线程：服务仍在监听 8188、HTTP 正常，
# 但之后所有 "got prompt" 都不再执行（表现为批量任务全部超时）。
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Set-Location 'C:\Users\30902\ComfyUI-Installs\ComfyUI'
& 'D:\1Repo\Github\ComfyUI\Library\.venv\Scripts\python.exe' -s ComfyUI\main.py --feature-flag show_signin_button=true --base-directory D:\1Repo\Github\ComfyUI\Library --user-directory D:\1Repo\Github\ComfyUI\Library\user --database-url sqlite:///D:\1Repo\Github\ComfyUI\Library\user\comfyui.db --port 8188 --enable-manager --extra-model-paths-config 'C:\Users\30902\AppData\Roaming\Comfy Desktop\instance-model-paths\inst-1780735988494.yaml' --input-directory D:\1Repo\Github\ComfyUI\Library\input --output-directory D:\1Repo\Github\ComfyUI\Library\output *> 'D:\1Repo\Github\ComfyUI\Library\comfyui.log'
