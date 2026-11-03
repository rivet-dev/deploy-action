"""Check plain registry.start() on a cold boot and a persistent restart."""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request


def wait_for_http(endpoint):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(endpoint, timeout=1) as response:
                assert response.status == 200
                return
        except (OSError, urllib.error.URLError):
            time.sleep(0.05)
    raise RuntimeError("App did not start listening")


def actor_request(endpoint, path, expected):
    # Deliberately make one actor request: retries here would hide startup failures.
    with urllib.request.urlopen(endpoint + path, timeout=90) as response:
        body = json.load(response)
        assert response.status == 200 and body == {"count": expected}, body


image = sys.argv[1]
container = subprocess.check_output([
    "docker", "run", "-d", "-p", "127.0.0.1::8080",
    "-e", "NODE_ENV=development", "-e", "RIVETKIT_STORAGE_PATH=/data", image,
], text=True).strip()
try:
    def endpoint():
        port = subprocess.check_output(["docker", "port", container, "8080"], text=True).strip().split(":")[-1]
        return "http://127.0.0.1:" + port

    url = endpoint()
    wait_for_http(url)
    actor_request(url, "/increment", 1)
    print("First cold-start actor request passed", flush=True)
    subprocess.run(["docker", "stop", "--time", "10", container], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["docker", "start", container], check=True, stdout=subprocess.DEVNULL)
    url = endpoint()
    wait_for_http(url)
    actor_request(url, "/count", 1)
    actor_request(url, "/increment", 2)
    print("First request after restart passed; actor state persisted", flush=True)
finally:
    subprocess.run(["docker", "stop", "--time", "5", container], stdout=subprocess.DEVNULL)
    subprocess.run(["docker", "rm", container], stdout=subprocess.DEVNULL)
