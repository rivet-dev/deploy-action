# One app for Cloud and Fly

This counter uses `setup({ use: { counter } })`, `registry.start()`, and `createClient()` with standard configuration. The same Dockerfile runs on both providers.

Set these action inputs for this repository:

```yaml
docker-build-path: examples/counter
dockerfile-path: examples/counter/Dockerfile
```

- `/` reports the app version and Node environment.
- `/increment` increments a persistent counter.
- `/count` reads it.

Cloud supplies the remote engine connection. Fly sets development mode so RivetKit starts its bundled engine and stores data on the preview volume. The internal metrics listener is for Rivet Cloud monitoring.

Run the cold-start check locally:

```sh
docker build -t rivet-counter examples/counter
python3 scripts/smoke-start.py rivet-counter
```
