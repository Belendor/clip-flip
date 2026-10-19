// ============================================================
//  Jenkinsfile — ClipFlip CI/CD Pipeline
//  Triggered by: GitHub webhook on push to main branch
//  What it does:
//    1. Checkout code from GitHub
//    2. Deploy files to /var/www/clipflip (served by Nginx)
//    3. Reload Nginx
// ============================================================

pipeline {
    agent any

    options {
        // Keep only last 10 builds to save disk space
        buildDiscarder(logRotator(numToKeepStr: '10'))
        timestamps()
        timeout(time: 10, unit: 'MINUTES')
    }

    triggers {
        // GitHub webhook will trigger this automatically
        githubPush()
    }

    environment {
        DEPLOY_DIR = '/var/www/clipflip'
        REPO_URL   = "https://github.com/Belendor/clip-flip.git"
        BRANCH     = 'main'
    }

    stages {

        stage('Checkout') {
            steps {
                echo "📥 Pulling latest code from GitHub..."
                checkout([
                    $class: 'GitSCM',
                    branches: [[name: "*/${env.BRANCH}"]],
                    userRemoteConfigs: [[
                        url: env.REPO_URL,
                        credentialsId: 'github-token'
                    ]]
                ])
            }
        }

        stage('Build') {
            steps {
                echo "🔨 Build stage — static site, no compilation needed."
                echo "   Files in workspace:"
                sh 'ls -lah'
                // Future: add minification here (html-minifier, terser, cleancss)
            }
        }

        stage('Deploy') {
            steps {
                echo "🚀 Deploying to ${env.DEPLOY_DIR}..."
                sh """
                    # Stamp deploy time into HTML data attribute
                    DEPLOY_TIME=\$(date '+%Y-%m-%d %H:%M UTC')
                    sed -i 's|<html lang="en">|<html lang="en" data-deploy-time="'\$DEPLOY_TIME'">|' index.html

                    # Sync all files to the web root
                    sudo mkdir -p ${env.DEPLOY_DIR}
                    sudo cp -r index.html src/ ${env.DEPLOY_DIR}/
                    sudo chown -R www-data:www-data ${env.DEPLOY_DIR}
                    sudo chmod -R 755 ${env.DEPLOY_DIR}
                """
            }
        }

        stage('Reload Nginx') {
            steps {
                echo "🔄 Reloading Nginx..."
                sh 'sudo systemctl reload nginx'
                echo "✅ Nginx reloaded. Site is live!"
            }
        }

    }

    post {
        success {
            echo "🎉 Deployment successful!"
        }
        failure {
            echo "❌ Deployment FAILED. Check logs above."
        }
        always {
            cleanWs() // Clean workspace after each build
        }
    }
}
