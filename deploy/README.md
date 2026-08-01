# Deployment

Runtime deployment assets for the `patient-collab-demo` server. The app listens
on `PORT` (3000 in production) and is fronted by an nginx reverse proxy for
`yorm.os.mieweb.org`.

## `yorm.service` — systemd unit

Starts the demo server (`pnpm start` → `tsx src/server.ts`) on port 3000 and
restarts it on failure. Enabled to launch on boot.

### Prerequisites (one-time)

The unit only *runs* the server; the client bundle and workspace packages must
already be built:

```sh
git submodule update --init --recursive          # vendor/eSheet, vendor/ui
pnpm install                                      # workspace deps
pnpm --filter patient-collab-demo esheet:build    # build vendored eSheet
pnpm --filter patient-collab-demo ui:build        # build vendored @mieweb/ui
pnpm build                                         # compile workspace packages (tsc -b)
pnpm --filter patient-collab-demo build            # vite build -> dist/
```

### Install / update

```sh
sudo cp deploy/yorm.service /etc/systemd/system/yorm.service
sudo systemctl daemon-reload
sudo systemctl enable --now yorm.service
```

### Operate

```sh
systemctl status yorm.service      # health
journalctl -u yorm.service -f      # follow logs
sudo systemctl restart yorm.service
```

After pulling new code, rebuild (`pnpm build` + the demo `build`) then
`sudo systemctl restart yorm.service`.
