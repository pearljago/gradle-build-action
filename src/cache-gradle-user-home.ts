import path from 'path'
import fs from 'fs'
import os from 'os'
import * as core from '@actions/core'
import * as glob from '@actions/glob'
import * as exec from '@actions/exec'

import {
    AbstractCache,
    getCacheKeyPrefix,
    hashFileNames,
    tryDelete
} from './cache-utils'

// Which paths under Gradle User Home should be cached
const CACHE_PATH = ['caches', 'notifications']

export class GradleUserHomeCache extends AbstractCache {
    private gradleUserHome: string

    constructor(rootDir: string) {
        super('gradle', 'Gradle User Home')
        this.gradleUserHome = this.determineGradleUserHome(rootDir)
    }

    async afterRestore(): Promise<void> {
        await this.reportGradleUserHomeSize('as restored from cache')
        await this.restoreArtifactBundles()
        await this.reportGradleUserHomeSize('after restoring common artifacts')
    }

    private async restoreArtifactBundles(): Promise<void> {
        const processes: Promise<void>[] = []
        for (const [bundle, pattern] of this.getArtifactBundles()) {
            const p = this.restoreArtifactBundle(bundle, pattern)
            // Run sequentially when debugging enabled
            if (this.cacheDebuggingEnabled) {
                await p
            }
            processes.push(p)
        }

        await Promise.all(processes)
    }

    private async restoreArtifactBundle(
        bundle: string,
        artifactPath: string
    ): Promise<void> {
        const bundleMetaFile = this.getBundleMetaFile(bundle)
        if (fs.existsSync(bundleMetaFile)) {
            const cacheKey = fs.readFileSync(bundleMetaFile, 'utf-8').trim()
            const restoreKey = await this.restoreCache([artifactPath], cacheKey)
            if (restoreKey) {
                core.info(
                    `Restored ${bundle} with key ${cacheKey} to ${artifactPath}`
                )
            } else {
                this.debug(
                    `Did not restore ${bundle} with key ${cacheKey} to ${artifactPath}`
                )
            }
        } else {
            this.debug(
                `No metafile found to restore ${bundle}: ${bundleMetaFile}`
            )
        }
    }

    private getBundleMetaFile(name: string): string {
        return path.resolve(
            this.gradleUserHome,
            'caches',
            `.gradle-build-action.${name}.cache`
        )
    }

    async beforeSave(): Promise<void> {
        await this.reportGradleUserHomeSize('before saving common artifacts')
        await this.saveArtifactBundles()
        await this.reportGradleUserHomeSize('after saving common artifacts')
    }

    private async saveArtifactBundles(): Promise<void> {
        const processes: Promise<void>[] = []
        for (const [bundle, pattern] of this.getArtifactBundles()) {
            const p = this.saveArtifactBundle(bundle, pattern)
            // Run sequentially when debugging enabled
            if (this.cacheDebuggingEnabled) {
                await p
            }
            processes.push(p)
        }

        await Promise.all(processes)
    }

    private async saveArtifactBundle(
        bundle: string,
        artifactPath: string
    ): Promise<void> {
        const bundleMetaFile = this.getBundleMetaFile(bundle)

        const globber = await glob.create(artifactPath, {
            implicitDescendants: false,
            followSymbolicLinks: false
        })
        const bundleFiles = await globber.glob()

        // Handle no matching files
        if (bundleFiles.length === 0) {
            this.debug(`No files found to cache for ${bundle}`)
            if (fs.existsSync(bundleMetaFile)) {
                tryDelete(bundleMetaFile)
            }
            return
        }

        const previouslyRestoredKey = fs.existsSync(bundleMetaFile)
            ? fs.readFileSync(bundleMetaFile, 'utf-8').trim()
            : ''
        const cacheKey = this.createCacheKey(bundle, bundleFiles)

        if (previouslyRestoredKey === cacheKey) {
            this.debug(
                `No change to previously restored ${bundle}. Not caching.`
            )
        } else {
            core.info(`Caching ${bundle} with cache key: ${cacheKey}`)
            await this.saveCache([artifactPath], cacheKey)

            this.debug(`Writing cache metafile: ${bundleMetaFile}`)
            fs.writeFileSync(bundleMetaFile, cacheKey)
        }

        for (const file of bundleFiles) {
            tryDelete(file)
        }
    }

    protected createCacheKey(bundle: string, files: string[]): string {
        const cacheKeyPrefix = getCacheKeyPrefix()
        const relativeFiles = files.map(x =>
            path.relative(this.gradleUserHome, x)
        )
        const key = hashFileNames(relativeFiles)

        this.debug(
            `Generating cache key for ${bundle} from files: ${relativeFiles}`
        )

        return `${cacheKeyPrefix}${bundle}-${key}`
    }

    protected determineGradleUserHome(rootDir: string): string {
        const customGradleUserHome = process.env['GRADLE_USER_HOME']
        if (customGradleUserHome) {
            return path.resolve(rootDir, customGradleUserHome)
        }

        return path.resolve(os.homedir(), '.gradle')
    }

    protected cacheOutputExists(): boolean {
        // Need to check for 'caches' directory to avoid incorrect detection on MacOS agents
        const dir = path.resolve(this.gradleUserHome, 'caches')
        return fs.existsSync(dir)
    }

    protected getCachePath(): string[] {
        return CACHE_PATH.map(x => path.resolve(this.gradleUserHome, x))
    }

    private getArtifactBundles(): Map<string, string> {
        const artifactBundleDefinition = core.getInput('cache-artifact-bundles')
        this.debug(
            `Using artifact bundle definition: ${artifactBundleDefinition}`
        )
        const artifactBundles = JSON.parse(artifactBundleDefinition)
        return new Map(
            Array.from(artifactBundles, ([key, value]) => [
                key,
                path.resolve(this.gradleUserHome, value)
            ])
        )
    }

    private async reportGradleUserHomeSize(label: string): Promise<void> {
        if (!this.cacheDebuggingEnabled) {
            return
        }
        if (!fs.existsSync(this.gradleUserHome)) {
            return
        }
        const result = await exec.getExecOutput(
            'du',
            ['-h', '-c', '-t', '5M'],
            {
                cwd: this.gradleUserHome,
                silent: true,
                ignoreReturnCode: true
            }
        )

        core.info(`Gradle User Home cache entry (directories >5M): ${label}`)

        core.info(
            result.stdout
                .trimEnd()
                .replace(/\t/g, '    ')
                .split('\n')
                .map(it => {
                    return `  ${it}`
                })
                .join('\n')
        )

        core.info('-----------------------')
    }
}
