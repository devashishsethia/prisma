import {
  Command,
  flags,
  Flags,
  Cluster,
  DeployPayload,
} from 'graphcool-cli-engine'
import chalk from 'chalk'
import * as sillyName from 'sillyname'
import { ServiceDoesntExistError } from '../../errors/ServiceDoesntExistError'
import { emptyDefinition } from './emptyDefinition'
import * as chokidar from 'chokidar'
import * as inquirer from 'graphcool-inquirer'
import * as path from 'path'
import * as fs from 'fs-extra'
const debug = require('debug')('deploy')

export default class Deploy extends Command {
  static topic = 'deploy'
  static description = 'Deploy service changes (or new service)'
  static group = 'general'
  static allowAnyFlags = true
  static help = `
  
  ${chalk.green.bold('Examples:')}
      
${chalk.gray(
    '-',
  )} Deploy local changes from graphcool.yml to the default service environment.
  ${chalk.green('$ graphcool deploy')}

${chalk.gray('-')} Deploy local changes to a specific stage
  ${chalk.green('$ graphcool deploy --stage production')}
    
${chalk.gray(
    '-',
  )} Deploy local changes from default service file accepting potential data loss caused by schema changes
  ${chalk.green('$ graphcool deploy --force --stage production')}
  `
  static flags: Flags = {
    stage: flags.string({
      char: 's',
      description: 'Local stage to deploy to',
    }),
    force: flags.boolean({
      char: 'f',
      description: 'Accept data loss caused by schema changes',
    }),
    watch: flags.boolean({
      char: 'w',
      description: 'Watch for changes',
    }),
    'new-service-cluster': flags.string({
      char: 'c',
      description: 'Name of the Cluster to deploy to',
    }),
    // alias: flags.string({
    //   char: 'a',
    //   description: 'Service alias',
    // }),
    interactive: flags.boolean({
      char: 'i',
      description: 'Force interactive mode to select the cluster',
    }),
    default: flags.boolean({
      char: 'D',
      description: 'Set specified stage as default',
    }),
    'dry-run': flags.boolean({
      char: 'd',
      description: 'Perform a dry-run of the deployment',
    }),
    json: flags.boolean({
      char: 'j',
      description: 'Json Output',
    }),
    dotenv: flags.string({
      description: 'Path to .env file to inject env vars',
    }),
  }
  private deploying: boolean = false
  private showedLines: number = 0
  async run() {
    debug('run')
    const { force, watch, interactive, dotenv } = this.flags
    const newServiceClusterName = this.flags['new-service-cluster']
    const dryRun = this.flags['dry-run']
    let stageName = this.flags.stage

    if (newServiceClusterName) {
      const newServiceCluster = this.env.clusterByName(newServiceClusterName)
      if (!newServiceCluster) {
        this.out.error(
          `You provided 'new-service-cluster' ${chalk.bold(
            newServiceClusterName,
          )}, but it doesn't exist. Please check your global ~/.graphcoolrc`,
        )
      } else {
        this.env.setActiveCluster(newServiceCluster)
      }
    }

    if (dotenv && !fs.pathExistsSync(path.join(this.config.cwd, dotenv))) {
      this.out.error(`--dotenv path '${dotenv}' does not exist`)
    }

    await this.definition.load(this.env, this.flags, dotenv)

    if (!stageName) {
      stageName =
        (!interactive &&
          this.definition.rawStages &&
          this.definition.rawStages.default) ||
        (await this.stageNameSelector('dev'))
    }

    let clusterName = this.definition.getStage(stageName)
    const serviceIsNew = !clusterName
    if (!clusterName) {
      clusterName =
        (!interactive && newServiceClusterName) ||
        (await this.clusterSelection())
    }

    if (this.showedLines > 0) {
      this.out.up(this.showedLines)
    }

    const serviceName = this.definition.definition!.service

    const cluster = this.env.clusterByName(clusterName!)
    if (!cluster) {
      this.out.error(`Cluster ${clusterName} could not be found.`)
    }
    this.env.setActiveCluster(cluster!)

    if (!await this.projectExists(serviceName, stageName)) {
      await this.addProject(serviceName, stageName)
    }

    await this.deploy(stageName, serviceName, cluster!, force, dryRun)

    if (watch) {
      this.out.log('Watching for change...')
      chokidar
        .watch(this.config.definitionDir, { ignoreInitial: true })
        .on('all', () => {
          setImmediate(async () => {
            if (!this.deploying) {
              await this.definition.load(this.env, this.flags)
              await this.deploy(
                stageName,
                this.definition.definition!.service,
                cluster!,
                force,
                dryRun,
              )
              this.out.log('Watching for change...')
            }
          })
        })
    }

    if (serviceIsNew) {
      this.definition.setStage(stageName, cluster!.name)
      this.definition.save()
      this.out.log(`Added stage ${stageName} to graphcool.yml\n`)
    }
  }

  private async projectExists(name: string, stage: string): Promise<boolean> {
    const projects = await this.client.listProjects()
    return Boolean(projects.find(p => p.name === name && p.stage === stage))
  }

  private async addProject(name: string, stage: string): Promise<void> {
    this.out.action.start(`Creating stage ${stage} for service ${name}`)
    const createdProject = await this.client.addProject(name, stage)
    this.out.action.stop()
  }

  private prettyTime(time: number): string {
    const output =
      time > 1000 ? (Math.round(time / 100) / 10).toFixed(1) + 's' : time + 'ms'
    return chalk.cyan(output)
  }

  private async deploy(
    stageName: string,
    serviceName: string,
    cluster: Cluster,
    force: boolean,
    dryRun: boolean,
  ): Promise<void> {
    this.deploying = true
    const localNote = cluster.local ? ' locally' : ''
    let before = Date.now()

    const b = s => `\`${chalk.bold(s)}\``

    const verb = dryRun ? 'Performing dry run for' : 'Deploying'

    this.out.action.start(
      `${verb} service ${b(serviceName)} to stage ${b(
        stageName,
      )} on cluster ${b(cluster.name)}`,
    )

    const migrationResult: DeployPayload = await this.client.deploy(
      serviceName,
      stageName,
      this.definition.typesString!,
      dryRun,
    )
    this.out.action.stop(this.prettyTime(Date.now() - before))
    this.printResult(migrationResult)

    if (migrationResult.migration.steps.length > 0 && !dryRun) {
      before = Date.now()
      this.out.action.start(`Applying changes`)
      await this.client.waitForMigration(
        serviceName,
        stageName,
        migrationResult.migration.revision,
      )
      this.out.action.stop(this.prettyTime(Date.now() - before))
    }

    // no action required
    this.deploying = false
    if (migrationResult.migration.steps.length > 0) {
      this.printEndpoints(cluster, serviceName, stageName)
    }
  }

  private printResult(payload: DeployPayload) {
    if (payload.errors && payload.errors.length > 0) {
      this.out.log(`${chalk.bold.red('Errors:')}`)
      this.out.migration.printErrors(payload.errors)
      this.out.log('')
      return
    }

    if (payload.migration.steps.length === 0) {
      this.out.log('Service is already up to date.')
      return
    }

    if (payload.migration.steps.length > 0) {
      // this.out.migrati
      this.out.log('\n' + chalk.bold('Changes:'))
      this.out.migration.printMessages(payload.migration.steps)
      this.out.log('')
    }
  }

  private printEndpoints(
    cluster: Cluster,
    serviceName: string,
    stageName: string,
  ) {
    this.out.log(`\n${chalk.bold('Your GraphQL database endpoint is live:')}

  ${chalk.bold('HTTP:')}  ${cluster.getApiEndpoint(serviceName, stageName)}\n`)
  }

  private async clusterSelection(): Promise<string> {
    const localClusters = this.env.clusters.filter(c => c.local).map(c => {
      return {
        value: c.name,
        name: c.name,
      }
    })
    const question = {
      name: 'cluster',
      type: 'list',
      message: 'Please choose the cluster you want to deploy to',
      choices: [
        new inquirer.Separator(chalk.bold('Shared Clusters:')),
        {
          value: 'shared-eu-west-1',
          name: 'shared-eu-west-1',
        },
        // {
        //   value: 'shared-ap-northeast-1',
        //   name: 'shared-ap-northeast-1',
        // },
        // {
        //   value: 'shared-us-west-2',
        //   name: 'shared-us-west-2',
        // },
        new inquirer.Separator('                     '),
        new inquirer.Separator(chalk.bold('Custom clusters (local/private):')),
      ].concat(localClusters),
      pageSize: 8,
    }

    const { cluster } = await this.out.prompt(question)
    this.showedLines += 2

    return cluster
  }

  private async stageNameSelector(defaultName: string): Promise<string> {
    const question = {
      name: 'stage',
      type: 'input',
      message: 'Please choose the stage name',
      default: defaultName,
    }

    const { stage } = await this.out.prompt(question)

    this.showedLines += 1

    return stage
  }

  // private async dryRun() {
  //   const { stage } = this.flags

  //   await this.definition.load(this.env, this.flags)
  //   // await this.auth.ensureAuth()

  //   const stageName = stage || 'default'

  //   this.out.action.start(
  //     `Getting diff for ${chalk.bold(id)} with stage ${chalk.bold(stageName)}.`,
  //   )

  //   try {
  //     const migrationResult = await this.client.push(
  //       id,
  //       false,
  //       true,
  //       this.definition.definition!,
  //     )
  //     this.out.action.stop()

  //     // no action required
  //     if (
  //       (!migrationResult.migrationMessages ||
  //         migrationResult.migrationMessages.length === 0) &&
  //       (!migrationResult.errors || migrationResult.errors.length === 0)
  //     ) {
  //       this.out.log(
  //         `Identical service definition for service ${chalk.bold(
  //           id,
  //         )} in env ${chalk.bold(stageName)}, no action required.\n`,
  //       )
  //       return
  //     }

  //     if (migrationResult.migrationMessages.length > 0) {
  //       this.out.log(
  //         chalk.blue(
  //           `Your service ${chalk.bold(id)} of env ${chalk.bold(
  //             stageName,
  //           )} has the following changes:`,
  //         ),
  //       )

  //       this.out.migration.printMessages(migrationResult.migrationMessages)
  //       this.definition.set(migrationResult.projectDefinition)
  //     }

  //     if (migrationResult.errors.length > 0) {
  //       this.out.log(
  //         chalk.rgb(244, 157, 65)(
  //           `There are issues with the new service definition:`,
  //         ),
  //       )
  //       this.out.migration.printErrors(migrationResult.errors)
  //       this.out.log('')
  //       process.exitCode = 1
  //     }

  //     if (
  //       migrationResult.errors &&
  //       migrationResult.errors.length > 0 &&
  //       migrationResult.errors[0].description.includes(`destructive changes`)
  //     ) {
  //       // potentially destructive changes
  //       this.out.log(
  //         `Your changes might result in data loss.
  //           Use ${chalk.cyan(
  //             `\`graphcool deploy --force\``,
  //           )} if you know what you're doing!\n`,
  //       )
  //       process.exitCode = 1
  //     }
  //   } catch (e) {
  //     this.out.action.stop()
  //     this.out.error(e)
  //   }
  // }
}

export function isValidProjectName(projectName: string): boolean {
  return /^[A-Z](.*)/.test(projectName)
}
