# ============================================================
#  Terraform — variables.tf
# ============================================================

variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "eu-north-1"
}

variable "aws_access_key" {
  description = "AWS Access Key ID"
  type        = string
  sensitive   = true
}

variable "aws_secret_key" {
  description = "AWS Secret Access Key"
  type        = string
  sensitive   = true
}

variable "vpc_id" {
  description = "ID of the existing VPC to deploy into"
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.micro"
}

variable "key_pair_name" {
  description = "Name for the AWS key pair"
  type        = string
  default     = "ClipFlipkey"
}

variable "ssh_public_key" {
  description = "SSH public key content (from your .pem file)"
  type        = string
}
