---
name: cloud-k8s
description: [Internal] Cloud and K8s attack surface: metadata, AK/SK, K8s API/kubelet/etcd, container escape, cloud control plane and object storage (awscli/az/gcloud/kubectl)
whenToUse: When cloud credentials, metadata, a K8s cluster, object storage or a cloud control plane are found on an internal host, cloud host or container, and you need to judge whether lateral movement or privilege escalation is possible
role: internal
category: Internal
tags: [cloud, k8s, metadata, container]
enabled: true
---

# Cloud / K8s attack surface

> Read-only first: enumerate permissions, read metadata, check whether APIs are unauthenticated; **do not delete resources, do not stop instances, do not modify IAM**. Back up and record original values before any write operation.

## Prerequisites and tools

| Tool | Purpose |
| --- | --- |
| `aws` / `az` / `gcloud` | Cloud CLIs and credential validation |
| `kubectl` | K8s API / kubeconfig / token |
| `kube-hunter` / `kube-bench` | Cluster exposure and configuration checks |
| `curl` / `jq` | metadata, API, object storage |
| `docker` / `crictl` | In-container enumeration |

When not installed, verify with `command -v`; if the CLI is missing, write it into `needs` — do not hand-roll cloud request signing.

## Find credentials first

- Environment variables: `AWS_*`, `AZURE_*`, `GOOGLE_*`, `KUBECONFIG`;
- Files: `~/.aws/credentials`, `~/.azure/`, `~/.config/gcloud/`, `/var/run/secrets/kubernetes.io/serviceaccount/token`;
- AK/SK in CI/CD, container env, application config, backups, logs;
- Once found, first confirm identity and permissions with `aws sts get-caller-identity` / `az account show` / `gcloud auth list`; **do not go straight to bulk operations**.

## Metadata (read-only)

```bash
# AWS
curl -s http://169.254.169.254/latest/meta-data/iam/security-credentials/
curl -s http://169.254.169.254/latest/meta-data/iam/security-credentials/<role>
# Azure (must carry Metadata:true)
curl -s -H Metadata:true 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://management.azure.com/'
# GCP
curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token
```

- Proving you can obtain a token/identity is enough; do not create resources just to "prove it".
- Cloud hosts/containers are scored under `cloud-platform`; AK/SK bulk control counts as node score by default unless administrator privileges can be proven.

## K8s

```bash
kubectl --token=<sa-token> --server=https://<api>:6443 --insecure-skip-tls-verify get nodes
kubectl auth can-i --list
# Common exposures: 6443 API, 10250 kubelet, 2379 etcd, dashboard, metrics
curl -k https://<api>:6443/version
curl -k https://<node>:10250/pods
```

- Watch for: anonymous/unauthenticated API, service account permissions, privileged/hostPath/hostNetwork Pods, mounted docker.sock, readable Secrets;
- For container escape, prefer read-only proof (mounts, caps, hostPID); do not damage the host;
- K8s control plane/nodes score under `cloud-platform` / `server-host`; model/compute clusters score under `model-compute`.

## Object storage / data

- S3/OSS/MinIO: first prove readability with `list`, then sample 1–3 objects; **do not download everything**;
- When PII triples/sensitive data are found, use `redteam_data_proof` to record fields/count/sample;
- File storage/backups score under `file-storage`, data volume under G2.

## Evidence and scoring

- Assets: `redteam_asset_add` / `redteam_batch kind=assets` (cloud hosts, APIs, object storage);
- Credentials: `redteam_credential_add` (AK/SK, token, kubeconfig);
- Scoring: `cloud-platform`, `server-host`, `model-compute`, `file-storage`; write commands/output into `score_hit`'s `command`/`result`;
- Boundaries: only consider `boundary-*` when crossing clouds/accounts into the primary defended organization's intranet, and provide evidence per the four questions.

## OPSEC and boundaries

- Do not delete instances/buckets/Secrets, do not modify IAM, do not stop Pods;
- Rate-limit API calls, use `get/list` before considering writes; sample only for object storage;
- Read cloud credentials only from env/files; never write them into command lines/reports/session output;
- Clean up tokens/files/containers you created and register `redteam_cleanup`.

## Handoff

Report back: cloud provider/account/role, K8s permissions, reachable cloud resources, data fields and record counts, and blockers; write missing CLIs/credentials/authorizations into `needs`.
