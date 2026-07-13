// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract VulnerableVault {
    mapping(address => uint256) public balances;
    address public owner;
    bool private initialized;

    function initialize(address _owner) public {
        owner = _owner;
    }

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "insufficient balance");
        (bool success, ) = msg.sender.call{value: amount}("");
        balances[msg.sender] -= amount;
    }

    function adminWithdraw(uint256 amount) external {
        payable(owner).transfer(amount);
    }

    function setOwner(address newOwner) public {
        owner = newOwner;
    }
}
