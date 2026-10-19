# ============================================================
#  Terraform — main.tf
#  ClipFlip: EC2 + Nginx + Jenkins on existing VPC
# ============================================================

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region     = var.aws_region
  access_key = var.aws_access_key
  secret_key = var.aws_secret_key
}

# ── Data: Existing VPC ──────────────────────────────────────
data "aws_vpc" "main" {
  id = var.vpc_id
}

# ── Data: Pick first public subnet in the VPC ──────────────
data "aws_subnets" "public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.main.id]
  }
  filter {
    name   = "map-public-ip-on-launch"
    values = ["true"]
  }
}

# Fallback: get ALL subnets if none have auto-assign public IP
data "aws_subnets" "all" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.main.id]
  }
}

locals {
  # Use first public subnet; fall back to any subnet
  subnet_id = length(data.aws_subnets.public.ids) > 0 ? (
    sort(data.aws_subnets.public.ids)[0]
  ) : sort(data.aws_subnets.all.ids)[0]
}

# ── Data: Latest Ubuntu 24.04 LTS AMI ──────────────────────
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ── Security Group ──────────────────────────────────────────
resource "aws_security_group" "clipflip" {
  name        = "clipflip-sg"
  description = "ClipFlip: SSH, HTTP, Jenkins"
  vpc_id      = data.aws_vpc.main.id

  # SSH
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTP (Nginx)
  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Jenkins
  ingress {
    description = "Jenkins"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTPS (future use)
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "clipflip-sg"
    Project = "clipflip"
  }
}

# ── Key Pair (already exists in AWS — reference it) ────────
data "aws_key_pair" "clipflip" {
  key_name = var.key_pair_name
}

# ── EC2 Instance ────────────────────────────────────────────
resource "aws_instance" "clipflip" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  key_name                    = data.aws_key_pair.clipflip.key_name
  subnet_id                   = local.subnet_id
  vpc_security_group_ids      = [aws_security_group.clipflip.id]
  associate_public_ip_address = true

  # Root volume — 20 GB gp3 is cheapest SSD
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 20
    delete_on_termination = true
    encrypted             = true
  }

  user_data = templatefile("${path.module}/scripts/userdata.sh", {
    github_repo     = var.github_repo
    github_username = var.github_username
    github_token    = var.github_token
  })

  tags = {
    Name    = "clipflip-server"
    Project = "clipflip"
  }

  lifecycle {
    ignore_changes = [ami] # Don't reprovision on AMI update
  }
}

# ── Elastic IP (so public IP survives stop/start) ──────────
resource "aws_eip" "clipflip" {
  instance = aws_instance.clipflip.id
  domain   = "vpc"

  tags = {
    Name    = "clipflip-eip"
    Project = "clipflip"
  }
}
