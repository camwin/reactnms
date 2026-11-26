#!/usr/bin/env python3
"""Back up one device configuration. Credentials arrive on stdin, never on argv."""
import json
import sys


def fail(message):
    json.dump({"ok": False, "error": str(message)[:500], "config": ""}, sys.stdout)
    sys.exit(0)


def clean(exc, secrets):
    text = f"{type(exc).__name__}: {exc}"
    for secret in secrets:
        if secret:
            text = text.replace(str(secret), "***")
    return text[:500]


def axis(host, username, password):
    try:
        import paramiko
    except Exception:
        return fail("Netmiko is not installed")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    text = ""
    try:
        client.connect(
            host,
            username=username,
            password=password,
            timeout=20,
            allow_agent=False,
            look_for_keys=False,
        )
        for command in ("param list", "show configuration"):
            try:
                _stdin, stdout, _stderr = client.exec_command(command, timeout=30)
                chunk = stdout.read().decode("utf-8", "replace")
                if chunk.strip():
                    text = chunk
                    break
            except Exception:
                continue
    except Exception as exc:
        return fail(clean(exc, [password]))
    finally:
        client.close()
    if not text.strip():
        return fail("Axis returned an empty configuration")
    json.dump({"ok": True, "error": "", "config": text}, sys.stdout)


def main():
    try:
        req = json.load(sys.stdin)
    except Exception:
        return fail("invalid backup request")
    device_type = str(req.get("device_type") or "")
    host = str(req.get("host") or "")
    username = str(req.get("username") or "")
    password = str(req.get("password") or "")
    secret = str(req.get("secret") or "")
    command = str(req.get("command") or "show running-config")
    if not host or not username or not password:
        return fail("username and password are required")
    if device_type == "axis":
        return axis(host, username, password)
    try:
        from netmiko import ConnectHandler
    except Exception:
        return fail("Netmiko is not installed")
    params = {
        "device_type": device_type,
        "host": host,
        "username": username,
        "password": password,
        "conn_timeout": 20,
        "auth_timeout": 20,
        "banner_timeout": 20,
        "fast_cli": False,
    }
    if secret:
        params["secret"] = secret
    try:
        conn = ConnectHandler(**params)
        try:
            if secret and (device_type.startswith("cisco") or device_type == "arista_eos"):
                conn.enable()
            output = conn.send_command(command, read_timeout=60)
        finally:
            conn.disconnect()
    except Exception as exc:
        return fail(clean(exc, [password, secret]))
    json.dump({"ok": True, "error": "", "config": output or ""}, sys.stdout)


if __name__ == "__main__":
    main()
