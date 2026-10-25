// ============================================================
//  Jenkinsfile — ClipFlip CI/CD Pipeline
//  Push to main → build TS + Tailwind → update Nginx → reload
// ============================================================

pipeline {
    agent any

    options {
        buildDiscarder(logRotator(numToKeepStr: '10'))
        timestamps()
        timeout(time: 15, unit: 'MINUTES')
    }

    triggers {
        githubPush()
    }

    environment {
        DEPLOY_DIR = '/var/www/clipflip'
        REPO_URL   = 'https://github.com/Belendor/clip-flip.git'
        BRANCH     = 'main'
    }

    stages {

        stage('Checkout') {
            steps {
                echo "📥 Pulling latest from GitHub..."
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

        stage('Install Dependencies') {
            steps {
                echo "📦 Installing npm packages..."
                sh 'npm ci --prefer-offline 2>&1 || npm install'
            }
        }

        stage('Build JS') {
            steps {
                echo "⚙️  Webpack production build..."
                sh 'npm run build:prod'
            }
        }

        stage('Build CSS') {
            steps {
                echo "🎨 TailwindCSS minified build..."
                sh 'npm run build:css'
            }
        }

        stage('Deploy App') {
            steps {
                echo "🚀 Deploying static assets to ${env.DEPLOY_DIR}..."
                sh """
                    sudo mkdir -p ${env.DEPLOY_DIR}/dist ${env.DEPLOY_DIR}/src

                    # Deploy HTML + built assets
                    sudo cp index.html ${env.DEPLOY_DIR}/index.html
                    sudo cp dist/bundle.js ${env.DEPLOY_DIR}/dist/bundle.js
                    sudo cp dist/output.css ${env.DEPLOY_DIR}/dist/output.css

                    # Fix permissions
                    sudo chown -R www-data:www-data ${env.DEPLOY_DIR}
                    sudo chmod -R 755 ${env.DEPLOY_DIR}
                """
            }
        }

        stage('Deploy Nginx Config') {
            steps {
                echo "🌐 Deploying Nginx site configuration..."
                sh """
                    if [ -f nginx/clipflip.conf ]; then
                        sudo cp nginx/clipflip.conf /etc/nginx/sites-available/clipflip
                        sudo cp nginx/clipflip.conf /etc/nginx/sites-enabled/clipflip
                        sudo rm -f /etc/nginx/sites-enabled/default
                    fi
                """
            }
        }

        stage('Reload Nginx') {
            steps {
                echo "🔄 Reloading Nginx service..."
                sh 'sudo systemctl reload nginx || sudo systemctl restart nginx'
                echo "✅ Nginx reloaded successfully. Live at http://56.228.95.201"
            }
        }
    }

    post {
        success {
            echo "🎉 Deploy successful! Build #${env.BUILD_NUMBER}"
        }
        failure {
            echo "❌ Build FAILED at stage. Check logs above."
        }
        always {
            cleanWs()
        }
    }
}
