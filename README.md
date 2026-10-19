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

1. You push code to `main` branch on GitHub
2. GitHub webhook notifies Jenkins
3. Jenkins pulls latest code
4. Files are copied to `/var/www/clipflip`
5. Nginx reloads — site is live within seconds

## Deployment

See [implementation_plan.md] for step-by-step setup instructions.
