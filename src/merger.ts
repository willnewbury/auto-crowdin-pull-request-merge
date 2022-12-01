import * as github from '@actions/github'
import * as core from '@actions/core'
import {PullsGetResponseData} from '@octokit/types'
import Retry from './retry'
import {inspect} from 'util'

export type labelStrategies = 'all' | 'atLeastOne'

export interface Inputs {
  checkStatus: boolean
  comment: string
  dryRun: boolean
  ignoreLabels: string[]
  ignoreLabelsStrategy: labelStrategies
  failStep: boolean
  intervalSeconds: number
  title: string
  repo: string
  owner: string
  pullRequestNumber: number
  sha: string
  strategy: Strategy
  token: string
  timeoutSeconds: number
}

export type Strategy = 'merge' | 'squash' | 'rebase'

interface ValidationResult {
  failed: boolean
  message: string
}

export class Merger {
  private retry: Retry

  constructor(private cfg: Inputs) {
    this.retry = new Retry()
      .timeout(this.cfg.timeoutSeconds)
      .interval(this.cfg.intervalSeconds)
      .failStep(this.cfg.failStep)
  }

  private isCrowdinPull(
    pr: PullsGetResponseData,
    title: string
  ): ValidationResult {
    let failed = true
    if (pr.title.includes(title)) {
      failed = false
    }

    return {
      failed,
      message: `The title of the PR with id ${pr.id} ${
        failed ? 'does not contain' : 'contains'
      } the proper title to be
        automatically merged`
    }
  }

  async merge(): Promise<void> {
    const client = github.getOctokit(this.cfg.token)
    const {owner, repo} = this.cfg

    try {
      await this.retry.exec(
        async (count): Promise<void> => {
          try {
            const {data: pr} = await client.pulls.get({
              owner,
              repo,
              pull_number: this.cfg.pullRequestNumber
            })

            const titleResult = this.isCrowdinPull(pr, this.cfg.title)

            if (titleResult.failed) {
              throw new Error(`Title checking failed: ${titleResult.message}`)
            }

            if (this.cfg.checkStatus) {
              const {data: checks} = await client.checks.listForRef({
                owner: this.cfg.owner,
                repo: this.cfg.repo,
                ref: this.cfg.sha
              })

              const totalStatus = checks.total_count
              const totalSuccessStatuses = checks.check_runs.filter(
                check =>
                  check.conclusion === 'success' ||
                  check.conclusion === 'skipped'
              ).length

              if (totalStatus - 1 !== totalSuccessStatuses) {
                throw new Error(
                  `Not all status succeeded, ${totalSuccessStatuses} out of ${
                    totalStatus - 1
                  } (ignored this check) success`
                )
              }

              core.debug(`All ${totalStatus} status success`)
              core.debug(`Merge PR ${pr.number}`)
            }
          } catch (err) {
            core.debug(
              `Failed, retry count:${count} with error ${inspect(err)}`
            )
            throw err
          }
        }
      )

      if (this.cfg.comment) {
        const {data: resp} = await client.issues.createComment({
          owner: this.cfg.owner,
          repo: this.cfg.repo,
          issue_number: this.cfg.pullRequestNumber,
          body: this.cfg.comment
        })

        core.debug(`Posting comment ${inspect(this.cfg.comment)}`)
        core.setOutput(`commentID`, resp.id)
      }

      if (!this.cfg.dryRun) {
        await client.pulls.merge({
          owner,
          repo,
          pull_number: this.cfg.pullRequestNumber,
          merge_method: 'squash'
        })
        core.setOutput('merged', true)
      } else {
        core.info(`dry run merge action`)
        core.setOutput('merged', false)
      }
    } catch (err) {
      core.debug(`Error on retry:${inspect(err)}`)
      if (this.cfg.failStep) {
        throw err
      }
      core.debug(
        'Timed out but passed because "failStep" is configured to false'
      )
    }
  }
}

export default {
  Merger
}
