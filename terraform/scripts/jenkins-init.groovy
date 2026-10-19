import com.cloudbees.jenkins.GitHubPushTrigger
import hudson.model.FreeStyleProject
import hudson.plugins.git.BranchSpec
import hudson.plugins.git.GitSCM
import hudson.tasks.Shell
import jenkins.model.Jenkins

def jenkins = Jenkins.get()
def jobName = 'clipflip-deploy'
def job = jenkins.getItem(jobName)

if (job == null) {
    job = jenkins.createProject(FreeStyleProject, jobName)
} else if (!(job instanceof FreeStyleProject)) {
    throw new IllegalStateException("Job '${jobName}' exists but is not a Freestyle job")
}

def scm = new GitSCM('https://github.com/Belendor/clip-flip.git')
scm.branches = [new BranchSpec('*/main')]
job.setScm(scm)
job.buildersList.clear()
job.buildersList.add(new Shell('sudo /usr/bin/systemctl restart nginx'))

if (job.getTrigger(GitHubPushTrigger) == null) {
    job.addTrigger(new GitHubPushTrigger())
}

job.save()
