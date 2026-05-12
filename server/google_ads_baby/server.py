from fastmcp import FastMCP

from .config import AdsConfig
from .tools import read, write

mcp = FastMCP("google-ads-baby")


def main():
    cfg = AdsConfig()
    read.register(mcp, cfg)
    write.register(mcp, cfg)
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
