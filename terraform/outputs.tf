# ============================================================
#  Terraform — outputs.tf
# ============================================================

output "instance_id" {
  description = "EC2 Instance ID"
  value       = aws_instance.clipflip.id
}

output "public_ip" {
  description = "Public IP — point your DNS here"
  value       = aws_eip.clipflip.public_ip
}

output "app_url" {
  description = "ClipFlip web app URL"
  value       = "http://${aws_eip.clipflip.public_ip}"
}

output "ssh_command" {
  description = "SSH command to connect to the instance"
  value       = "ssh -i C:/Users/belendor/Downloads/ClipFlipkey.pem ubuntu@${aws_eip.clipflip.public_ip}"
}
