pragma solidity ^0.8.19;

/// @dev Minimal ERC20 interface (must be declared at top level)
interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @title BatchSender - Send ERC20 tokens or native ETH to many recipients in one tx
/// @notice For ERC20 transfers, the sender must `approve` this contract for the total amount first.
contract BatchSender {

    event BatchTransferERC20(address indexed token, address indexed from, uint256 totalAmount, uint256 recipientCount);
    event BatchTransferNative(address indexed from, uint256 totalAmount, uint256 recipientCount);

    /// @notice Batch transfer ERC20 tokens from the caller to multiple recipients.
    /// @param token ERC20 token address
    /// @param recipients List of recipient addresses
    /// @param amounts List of token amounts for each recipient (aligned with `recipients`)
    function batchTransferERC20(
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external {
        require(token != address(0), "Invalid token");
        require(recipients.length == amounts.length, "Length mismatch");
        require(recipients.length > 0, "Empty arrays");

        uint256 total;
        for (uint256 i = 0; i < amounts.length; i++) {
            total += amounts[i];
        }
        require(IERC20(token).allowance(msg.sender, address(this)) >= total, "Insufficient allowance");

        for (uint256 i = 0; i < recipients.length; i++) {
            uint256 amt = amounts[i];
            if (amt == 0) continue;
            address to = recipients[i];
            require(to != address(0), "Zero recipient");
            _safeTransferFrom(token, msg.sender, to, amt);
        }

        emit BatchTransferERC20(token, msg.sender, total, recipients.length);
    }

    /// @notice Batch send native ETH to multiple recipients.
    /// @dev `msg.value` must equal the sum of `amounts`.
    /// @param recipients List of recipient addresses
    /// @param amounts List of ETH amounts for each recipient (aligned with `recipients`)
    function batchTransferNative(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external payable {
        require(recipients.length == amounts.length, "Length mismatch");
        require(recipients.length > 0, "Empty arrays");

        uint256 total;
        for (uint256 i = 0; i < amounts.length; i++) {
            total += amounts[i];
        }
        require(msg.value == total, "Invalid msg.value");

        for (uint256 i = 0; i < recipients.length; i++) {
            uint256 amt = amounts[i];
            if (amt == 0) continue;
            address to = recipients[i];
            require(to != address(0), "Zero recipient");
            (bool ok, ) = to.call{value: amt}("");
            require(ok, "ETH transfer failed");
        }

        emit BatchTransferNative(msg.sender, total, recipients.length);
    }

    /// @dev Minimal safe ERC20 wrappers using low-level calls to support non-standard tokens
    function _safeTransferFrom(address token, address from, address to, uint256 value) internal {
        bytes memory data = abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value);
        _callOptionalReturn(token, data);
    }

    function _safeTransfer(address token, address to, uint256 value) internal {
        bytes memory data = abi.encodeWithSelector(IERC20.transfer.selector, to, value);
        _callOptionalReturn(token, data);
    }

    function _callOptionalReturn(address token, bytes memory data) private {
        (bool success, bytes memory returndata) = token.call(data);
        require(success, "ERC20 call failed");
        if (returndata.length > 0) {
            // Tokens may or may not return a boolean; if they do, require true
            require(abi.decode(returndata, (bool)), "ERC20 operation returned false");
        }
    }

    // Allow receiving ETH (e.g., refunds) without data
    receive() external payable {}
}