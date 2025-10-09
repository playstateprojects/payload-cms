import { withPayload } from '@payloadcms/next/withPayload'
import MiniCssExtractPlugin from 'mini-css-extract-plugin'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Your Next.js config here
  webpack: (webpackConfig: any) => {
    webpackConfig.resolve.extensionAlias = {
      '.cjs': ['.cts', '.cjs'],
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    }

    // Add MiniCssExtractPlugin
    webpackConfig.plugins.push(new MiniCssExtractPlugin())

    
    return webpackConfig
  },
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
