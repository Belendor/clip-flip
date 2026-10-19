# ============================================================
#  README.md — ClipFlip
# ============================================================

# ⚡ ClipFlip

A lean, CI/CD-powered static web app served on AWS EC2 via Nginx,
with Jenkins handling automated deployments triggered by GitHub pushes.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML + CSS + JS (vanilla) |
| Web Server | Nginx |
| CI/CD | Jenkins |
| Infrastructure | AWS EC2 (t3.micro), Terraform |
| Region | eu-north-1 (Stockholm) |

## Project Structure

```
ClipFlip/
├── index.html          # Main app entry point
├── src/
│   ├── style.css       # Styles
│   └── script.js       # Client-side logic
├── Jenkinsfile         # CI/CD pipeline definition
└── terraform/
    ├── main.tf         # EC2, SG, EIP resources
    ├── variables.tf    # Input variables
    ├── outputs.tf      # Public IP, URLs
    ├── terraform.tfvars  # Secret values (gitignored!)
    └── scripts/
        └── userdata.sh # EC2 first-boot bootstrap
```

## How CI/CD Works

1. Create a Jenkins **Freestyle project** with source control set to Git, repository URL `https://github.com/Belendor/clip-flip.git`, and branch specifier `*/main`.
2. Add a **Build Step → Execute shell** containing `sudo /usr/bin/systemctl restart nginx`.
3. Enable **GitHub hook trigger for GITScm polling** in the job's Build Triggers.
4. Add a GitHub repository webhook pointing to `http://<EC2-public-IP>:8080/github-webhook/`, with content type `application/json` and the `push` event. The webhook is not created automatically; add it once under **Settings → Webhooks**.
5. A push to `main` triggers Jenkins to check out the repo and restart Nginx.

This pipeline currently only checks out the repository and restarts Nginx; it does not copy updated site files into Nginx's web root. After creating the job, run **Build Now** once to test it. Port 8080 must be reachable from GitHub for webhook delivery.

The repository is public, so Jenkins clones it without a GitHub token. Terraform bootstraps this `clipflip-deploy` Freestyle project on newly created instances. The EC2 user-data script runs only at instance creation; for existing instances, the job is provisioned by `terraform/scripts/jenkins-init.groovy`. The GitHub webhook must still be added under repository settings.

## Deployment

See [implementation_plan.md] for step-by-step setup instructions.
